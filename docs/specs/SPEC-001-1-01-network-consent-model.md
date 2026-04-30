# SPEC-001-1-01: Network Consent Model + ConsentManager + Network Fingerprinting

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 1 (network-consent-v1.json schema), Task 2 (ConsentManager class), Task 3 (network fingerprinting)
- **Estimated effort**: 7.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-1-01-network-consent-model.md`

## Description
Deliver the per-CIDR network-consent foundation for the autonomous-dev-homelab plugin per TDD §5: a JSON Schema for `<homelab-data>/network_consent.yaml`, a `ConsentManager` class that gates every probe through operator approval, and best-effort network fingerprinting that invalidates consent when the daemon moves networks (preventing drive-by scans on coffee-shop WiFi). This spec is the single source of truth for whether a probe is allowed; siblings (SPEC-001-1-02 prober, SPEC-001-1-04 CLI) consume it as a black box.

The schema validates the on-disk file shape; `ConsentManager` provides the runtime API (`checkConsent`, `requestConsent`, `networkFingerprint`); fingerprinting derives a stable string from the default gateway and DNS servers so consent re-approval is forced when those change. No probes, no inventory, no CLI -- those are layered in by sibling specs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/schemas/network-consent-v1.json` | Create | JSON Schema (draft-07) for the consent file |
| `plugins/autonomous-dev-homelab/src/consent/manager.ts` | Create | `ConsentManager` class with check/request/fingerprint methods |
| `plugins/autonomous-dev-homelab/src/consent/fingerprint.ts` | Create | OS-aware default-gateway + DNS resolver helpers |
| `plugins/autonomous-dev-homelab/src/consent/types.ts` | Create | TypeScript types matching the schema |
| `plugins/autonomous-dev-homelab/tests/fixtures/consent/valid.yaml` | Create | TDD §5 example used by schema tests |
| `plugins/autonomous-dev-homelab/tests/fixtures/consent/expired.yaml` | Create | Past `expires_at`, used by manager tests |

## Implementation Details

### `network-consent-v1.json` Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://autonomous-dev/schemas/network-consent-v1.json",
  "type": "object",
  "required": ["version", "consents"],
  "properties": {
    "version": { "const": "1.0" },
    "consents": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["cidr", "approved_at", "expires_at", "permitted_ports", "permitted_scan_types"],
        "properties": {
          "cidr": {
            "type": "string",
            "pattern": "^(\\d{1,3}\\.){3}\\d{1,3}/(3[0-2]|[12]?\\d)$"
          },
          "approved_at": { "type": "string", "format": "date-time" },
          "expires_at": { "type": "string", "format": "date-time" },
          "approved_by": { "type": "string" },
          "note": { "type": "string" },
          "network_fingerprint": { "type": "string" },
          "permitted_ports": {
            "type": "array",
            "items": { "type": "integer", "minimum": 1, "maximum": 65535 },
            "minItems": 1
          },
          "permitted_scan_types": {
            "type": "array",
            "items": { "type": "string", "enum": ["http_probe", "ssh_probe", "tcp_connect"] },
            "minItems": 1
          }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

### `ConsentManager` Public API

```typescript
export interface Consent {
  cidr: string;
  approved_at: string;
  expires_at: string;
  approved_by?: string;
  note?: string;
  network_fingerprint?: string;
  permitted_ports: number[];
  permitted_scan_types: ScanType[];
}

export type ScanType = 'http_probe' | 'ssh_probe' | 'tcp_connect';

export class ConsentManager {
  constructor(consentFilePath: string, opts?: { defaultExpiryDays?: number; promptFn?: (msg: string) => Promise<boolean> });

  /** Returns the matching consent if `ip` is in a consented CIDR, not expired, and the
   *  current network fingerprint matches the stored one. Returns null otherwise. */
  async checkConsent(ip: string): Promise<Consent | null>;

  /** Interactive: shows the proposed CIDR, ports, scan types, and current fingerprint;
   *  on operator approval, persists to the consent file (atomic write) with `expires_at`
   *  = now + defaultExpiryDays (default 90). On rejection, returns false. */
  async requestConsent(cidr: string, ports: number[], scanTypes: ScanType[]): Promise<boolean>;

  /** Returns `route=<default-gw>;dns=<dns1,dns2>` for the current host. Best-effort. */
  async networkFingerprint(): Promise<string>;
}
```

Behavioral rules:
- `checkConsent` MUST reject if `now >= expires_at`. The expired entry stays in the file (audit trail) but returns null.
- `checkConsent` MUST reject if the stored `network_fingerprint` differs from the current one (operator must re-approve). A consent without a stored fingerprint is treated as "any network" (legacy import case).
- `requestConsent` MUST be a no-op (return false) if the operator answers anything other than `yes`/`y` (case-insensitive).
- All file writes MUST be atomic: write to `<file>.tmp.<pid>`, `fsync`, `rename`. Concurrent writers from the same process serialize via an in-process mutex on the file path.
- YAML loading MUST use `js-yaml`'s `safeLoad` (or `load` with `JSON_SCHEMA`) to prevent code execution.

### Network Fingerprinting (`fingerprint.ts`)

```typescript
/** Detects the OS, runs the appropriate command, and returns the gateway IP.
 *  Throws { code: 'NO_DEFAULT_GW' } if no default route exists. */
export async function getDefaultGateway(): Promise<string>;

/** Reads `/etc/resolv.conf`; returns nameserver IPs in declared order, deduped. */
export async function getDnsServers(): Promise<string[]>;

/** Composes the fingerprint string. Returns `route=unknown;dns=` if either lookup
 *  throws -- consent stored under `unknown` matches `unknown` only. */
export async function computeFingerprint(): Promise<string>;
```

OS dispatch:
- Linux: `ip -4 route show default` → parse `default via <ip> dev ...`
- macOS: `route -n get default` → parse line `gateway: <ip>`
- Other: throw `NO_DEFAULT_GW`; caller logs and uses `unknown`.

`getDnsServers` reads `/etc/resolv.conf` line-by-line, extracting `nameserver <ip>`. Comments (`#` prefix) ignored. Returns `[]` if file missing or unreadable.

### Override Hook

`ConsentManager` MUST honor an environment variable `AUTONOMOUS_DEV_HOMELAB_NETWORK_FINGERPRINT_OVERRIDE`; when set, `networkFingerprint()` returns that value verbatim. This unblocks operators on systems with non-standard network stacks (systemd-resolved with split DNS, VPN-only environments).

## Acceptance Criteria

- [ ] `network-consent-v1.json` validates `tests/fixtures/consent/valid.yaml` (TDD §5 example).
- [ ] Schema rejects an entry with missing `cidr`.
- [ ] Schema rejects `cidr: "192.168.x.x/24"` (regex mismatch).
- [ ] Schema rejects `permitted_scan_types: ["dns_query"]` (not in enum).
- [ ] Schema rejects `permitted_ports: [70000]` (out of range).
- [ ] `checkConsent('192.168.1.50')` returns the matching consent for a `192.168.1.0/24` entry with current fingerprint and unexpired `expires_at`.
- [ ] `checkConsent('10.0.0.5')` returns `null` when no consent covers `10.0.0.0/8`.
- [ ] `checkConsent` returns `null` for an entry whose `expires_at` is 1 second in the past.
- [ ] `checkConsent` returns `null` when the current fingerprint differs from the stored one.
- [ ] `requestConsent('192.168.2.0/24', [80, 443], ['http_probe'])` with `promptFn` resolving `true` writes a new entry with `expires_at` ≈ now + 90 days, the current fingerprint, and the supplied ports/scan types; returns `true`.
- [ ] `requestConsent` with `promptFn` resolving `false` does NOT write to disk; returns `false`.
- [ ] `requestConsent` performs an atomic write: a kill-during-write leaves either the prior contents or the new contents, never partial.
- [ ] Two concurrent `requestConsent` calls for distinct CIDRs both succeed and both entries are present (in-process mutex serializes them).
- [ ] `networkFingerprint()` on Linux returns `route=192.168.1.1;dns=192.168.1.1` when `ip route` and `/etc/resolv.conf` are mocked accordingly.
- [ ] `networkFingerprint()` on macOS returns the same shape when `route -n get default` is mocked.
- [ ] `networkFingerprint()` returns `route=unknown;dns=` when underlying commands throw.
- [ ] `AUTONOMOUS_DEV_HOMELAB_NETWORK_FINGERPRINT_OVERRIDE=route=test;dns=test` causes `networkFingerprint()` to return that string verbatim.
- [ ] YAML loading uses safe loader (verified by feeding `!!js/function 'function(){}'` and asserting it does NOT execute / load fails cleanly).

## Dependencies

- External: `js-yaml` (>=4.0; safe loader API), `ajv` (>=8.0; for schema validation in tests), Node `child_process` (for OS commands), Node `fs/promises`.
- Internal: TDD-007 / PLAN-007-X (autonomous-dev) `<homelab-data>` location resolution -- consumed via constructor argument; this spec does NOT resolve the path itself.
- Tests: `tap` or `vitest` (whichever the homelab plugin standardizes on; check `package.json`).

## Notes

- The schema's `cidr` regex is intentionally simple (no full IPv4 validation per octet); operator typos like `999.0.0.0/24` slip through the regex but fail at `checkConsent` time when the CIDR-contains-IP math runs. This is acceptable for v1; a stricter regex can land in v2.
- IPv6 is explicitly out of scope for v1 -- the regex rejects it. TDD §5 documents this.
- `permitted_scan_types` is a closed enum (`http_probe | ssh_probe | tcp_connect`). New scan types require a schema bump (v1.1) and a coordinated rollout. SPEC-001-1-02 only consumes `http_probe`; the others are reserved for PLAN-001-2.
- Network fingerprinting is best-effort by design. False positives (fingerprint changes when the operator merely restarts their router) force re-approval, which is the safer failure mode. Operators who find this annoying use the override env var.
- The in-process mutex is per-file-path, not global. Cross-process serialization (multiple daemon instances on the same host) is out of scope; v1 assumes a single daemon per host (TDD §3 deployment model).
- `requestConsent` storing the fingerprint at approval time means: if the operator approves on network A and then moves to network B without re-approving, all probes are rejected. This is correct behavior.
