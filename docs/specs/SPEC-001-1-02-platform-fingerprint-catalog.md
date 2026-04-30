# SPEC-001-1-02: Platform-Fingerprint Catalog + PlatformProber

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 4 (platform-fingerprint catalog for 7 platforms), Task 5 (PlatformProber)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-1-02-platform-fingerprint-catalog.md`

## Description
Deliver the declarative catalog of platform fingerprints (TDD §6) and the prober that uses them. The catalog is a static TypeScript table mapping each supported homelab platform (Unraid, Proxmox VE, Docker, Kubernetes, Docker Swarm, UniFi, TrueNAS) to a probe specification (HTTP/HTTPS GET on a known port and path) plus an expected-response matcher (regex or JSONPath) and a confidence score. `PlatformProber` consumes the catalog plus a `Consent` (from SPEC-001-1-01) to scan a CIDR, returning matched platforms with type, IP, port, and confidence.

This spec adds no I/O beyond outbound HTTPS probes, no persistence, no CLI, no consent logic. Consent is enforced by the caller passing a valid `Consent` object; the prober treats it as immutable input. Inventory writes happen in SPEC-001-1-03; CLI wiring happens in SPEC-001-1-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/discovery/fingerprints.ts` | Create | Static catalog: 7 platform entries |
| `plugins/autonomous-dev-homelab/src/discovery/prober.ts` | Create | `PlatformProber` class with `scan(cidr, consent)` |
| `plugins/autonomous-dev-homelab/src/discovery/types.ts` | Create | `PlatformType`, `Fingerprint`, `MatchedPlatform` types |
| `plugins/autonomous-dev-homelab/src/discovery/cidr.ts` | Create | `enumerateHosts(cidr): IterableIterator<string>` (excludes network/broadcast for /24-/30; includes single addr for /32) |
| `plugins/autonomous-dev-homelab/tests/fixtures/probes/proxmox-response.json` | Create | Real-world Proxmox `/api2/json/version` body |
| `plugins/autonomous-dev-homelab/tests/fixtures/probes/unraid-response.html` | Create | Realistic Unraid login page snippet |

## Implementation Details

### Type Definitions (`types.ts`)

```typescript
export type PlatformType =
  | 'unraid' | 'proxmox-ve' | 'docker' | 'kubernetes'
  | 'docker-swarm' | 'unifi' | 'truenas';

export interface Fingerprint {
  platformType: PlatformType;
  probe: {
    protocol: 'http' | 'https';
    port: number;
    path: string;
    method?: 'GET';                    // GET only in v1
    timeoutMs?: number;                // default 3000
    headers?: Record<string, string>;
  };
  expectedResponse:
    | { kind: 'regex'; pattern: string; flags?: string; confidence: number }
    | { kind: 'jsonPath'; path: string; equals?: unknown; exists?: true; confidence: number };
  notes?: string;                      // human-readable; not parsed
}

export interface MatchedPlatform {
  platformType: PlatformType;
  ip: string;
  port: number;
  protocol: 'http' | 'https';
  confidence: number;                  // [0, 1]
  matchedAt: string;                   // ISO-8601
  responseSnippet?: string;            // first 200 chars, for debugging
}
```

### Catalog Contents (`fingerprints.ts`)

The exported `PLATFORM_FINGERPRINTS: Fingerprint[]` MUST contain exactly these 7 entries. Each entry's confidence reflects how distinctive the response is; all confidences MUST be in `[0.85, 0.99]`.

| Platform | Protocol | Port | Path | Match | Confidence |
|----------|----------|------|------|-------|------------|
| `unraid` | https | 443 | `/login` | regex `Unraid\\.net\|/webGui/styles/` | 0.92 |
| `proxmox-ve` | https | 8006 | `/api2/json/version` | jsonPath `$.data.version` exists | 0.98 |
| `docker` | http | 2375 | `/_ping` | regex `^OK$` | 0.95 |
| `kubernetes` | https | 6443 | `/version` | jsonPath `$.gitVersion` exists | 0.99 |
| `docker-swarm` | http | 2377 | `/info` | jsonPath `$.Swarm.NodeID` exists | 0.95 |
| `unifi` | https | 8443 | `/manage/account/login` | regex `UniFi\|ubiquiti` | 0.90 |
| `truenas` | https | 443 | `/api/v2.0/system/info` | jsonPath `$.system_serial` exists | 0.97 |

Each entry's `notes` MUST cite the upstream doc URL (e.g., Proxmox API docs) so future maintainers can verify when a platform changes.

Probes MUST set `User-Agent: autonomous-dev-homelab-prober/0.1` so operators can identify the daemon in their logs.

### `PlatformProber` API

```typescript
export class PlatformProber {
  constructor(opts?: {
    catalog?: Fingerprint[];           // defaults to PLATFORM_FINGERPRINTS
    concurrency?: number;              // default 50
    httpClient?: HttpClient;           // injectable for tests
  });

  /** Probes every host in `cidr`, honoring `consent.permitted_ports` and
   *  `consent.permitted_scan_types`. Returns one MatchedPlatform per (ip, port, fingerprint)
   *  match. Skips probes whose port is not in `consent.permitted_ports`. Returns []
   *  if `consent.permitted_scan_types` does not include `'http_probe'`. */
  async scan(cidr: string, consent: Consent): Promise<MatchedPlatform[]>;
}
```

Behavioral rules:
- A single IP MAY match multiple fingerprints (e.g., a host running both Docker and Kubernetes); both matches are returned.
- HTTPS probes MUST tolerate self-signed certs (`rejectUnauthorized: false`) -- homelab platforms ubiquitously ship self-signed certs. This is documented in TDD §6.
- Probes MUST timeout per `Fingerprint.probe.timeoutMs` (default 3000ms). Timed-out probes log a debug message and produce no match.
- HTTP errors (4xx/5xx) MUST NOT be treated as matches even if the body matches the regex. Only `2xx` responses are evaluated.
- The prober MUST NOT short-circuit on the first match; it runs every applicable fingerprint against every host in the CIDR (capped by `concurrency`).
- Concurrency: at most `concurrency` in-flight HTTP requests at any time. Use a simple semaphore; no third-party pool library.
- Match recorded only if `expectedResponse` evaluates true:
  - `regex`: `new RegExp(pattern, flags).test(body)`
  - `jsonPath` with `exists: true`: lookup must yield a defined value (not `undefined`)
  - `jsonPath` with `equals`: lookup value must `===` the supplied literal

### CIDR Enumeration (`cidr.ts`)

```typescript
/** Yields each usable host IP in the CIDR.
 *  - /32: yields the single address.
 *  - /31: yields both addresses (RFC 3021 point-to-point).
 *  - /30 and broader: excludes network address and broadcast address.
 *  - Throws on invalid CIDR. */
export function* enumerateHosts(cidr: string): IterableIterator<string>;
```

Use bitwise math on 32-bit integers; no third-party CIDR library. Validate with the same regex used in SPEC-001-1-01's schema before parsing.

### HTTP Client Abstraction

```typescript
export interface HttpResponse {
  statusCode: number;
  body: string;                        // already utf-8 decoded
  headers: Record<string, string>;
}
export interface HttpClient {
  get(url: string, opts: { headers: Record<string, string>; timeoutMs: number; allowSelfSigned: boolean }): Promise<HttpResponse>;
}
```

The default implementation uses Node's `https`/`http` module directly (no `node-fetch`, no `axios`). Tests inject a fake `HttpClient`.

## Acceptance Criteria

- [ ] `PLATFORM_FINGERPRINTS` exports exactly 7 entries with `platformType` covering all 7 enumerated values; no duplicates.
- [ ] Every entry's `confidence` is in `[0.85, 0.99]`.
- [ ] Every entry's `notes` includes a non-empty URL string.
- [ ] No entry uses path `/` -- enforced by a unit test that fails if any fingerprint's `probe.path === '/'`.
- [ ] Each fingerprint matches its corresponding `tests/fixtures/probes/*` fixture and rejects a "similar but different" body (e.g., a generic nginx welcome page).
- [ ] `enumerateHosts('192.168.1.0/29')` yields exactly 6 IPs: `192.168.1.1` through `192.168.1.6`.
- [ ] `enumerateHosts('192.168.1.5/32')` yields exactly `['192.168.1.5']`.
- [ ] `enumerateHosts('10.0.0.0/31')` yields `['10.0.0.0', '10.0.0.1']`.
- [ ] `enumerateHosts('999.0.0.0/24')` throws.
- [ ] `prober.scan(cidr, consent)` with `permitted_scan_types: ['ssh_probe']` (no `http_probe`) returns `[]` and performs zero HTTP requests.
- [ ] `prober.scan(cidr, consent)` with `permitted_ports: [443]` skips fingerprints whose `probe.port` is anything other than 443; verified by counting calls on the injected `HttpClient`.
- [ ] Given a fake `HttpClient` that returns Proxmox's version JSON for `https://192.168.1.10:8006/api2/json/version` and 404 for everything else, `scan('192.168.1.10/32', consent)` returns exactly one match: `{ platformType: 'proxmox-ve', ip: '192.168.1.10', port: 8006, confidence: 0.98 }`.
- [ ] A host returning `200 OK` with body matching both Docker AND Kubernetes fingerprints produces TWO matches.
- [ ] A 4xx response with a body matching the regex does NOT produce a match.
- [ ] A timed-out probe (HttpClient throws `TimeoutError`) does NOT produce a match and does NOT throw out of `scan`.
- [ ] At most `concurrency` (default 50) HTTP requests are in flight at once -- verified by instrumenting the fake client to track concurrent calls.
- [ ] Probe headers include `User-Agent: autonomous-dev-homelab-prober/0.1`.
- [ ] HTTPS probes set `allowSelfSigned: true` -- verified by inspecting the args passed to `HttpClient.get`.
- [ ] `responseSnippet` on each match is the first 200 characters of the response body.

## Dependencies

- Internal: SPEC-001-1-01 -- consumes `Consent` and `ScanType` types only (no runtime dep on `ConsentManager`).
- External: Node's built-in `http`/`https` modules. A small JSONPath helper -- prefer hand-rolled (only `$.a.b.c` style needed) over a library; if a lib is required, use `jsonpath-plus` (no eval).
- Tests: same test runner as SPEC-001-1-01.

## Notes

- The 7 fingerprints listed are the v1 catalog. Adding new platforms post-v1 is a one-line append to `PLATFORM_FINGERPRINTS`; no API changes required. PLAN-001-1 risk register notes the operator-extensible `<homelab-data>/custom-fingerprints.yaml` path -- this is OUT OF SCOPE for SPEC-001-1-02 and lands in PLAN-001-3.
- HTTP-only Docker on port 2375 is a security smell; matching it does NOT mean the operator should connect to it. The connection layer (PLAN-001-2) decides whether and how to connect; the prober only reports presence.
- Confidence scores are calibrated by hand against TDD §6 examples. The 0.85 floor reflects the operator-confirmation policy (TDD risk register: confidence < 0.7 triggers manual confirmation; the v1 catalog is engineered to never produce <0.85).
- `concurrency: 50` is a default chosen to keep a `/24` scan under 30 seconds while not saturating typical home routers. Configurable per-call in v1.1 if operators need it.
- We deliberately do NOT use a CIDR library (e.g., `ip-cidr`, `ipaddr.js`) because the math is trivial for IPv4 and adding deps to the homelab plugin's runtime dep list inflates the install footprint. Tests cover the corner cases.
- Self-signed cert tolerance is non-negotiable: requiring valid certs would make the prober useless against 95% of real homelab platforms. Documented in TDD §6 and the operator README (PLAN-001-3).
