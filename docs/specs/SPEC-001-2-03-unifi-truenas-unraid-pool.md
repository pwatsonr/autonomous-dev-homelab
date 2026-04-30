# SPEC-001-2-03: UniFi + TrueNAS + Unraid Connection Subclasses + ConnectionPool

## Metadata
- **Parent Plan**: PLAN-001-2 (Connection Layer + SSH Certificate Authority)
- **Parent TDD**: TDD-001-platform-discovery-connection (§8 Connection Layer)
- **Tasks Covered**: Rest of Task 5 (`UnifiConnection`, `TrueNasConnection`, `UnraidConnection`), Task 6 (`ConnectionPool`)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-2-03-unifi-truenas-unraid-pool.md`

## Description
Completes the connection subclass set for "appliance-class" platforms (UniFi controllers, TrueNAS appliances, Unraid servers) and adds the `ConnectionPool` that caches open connections across exec calls. Each appliance subclass deviates from the SSH-or-MCP pattern of SPEC-001-2-02 in a specific way: UniFi has no SSH (HTTPS API only), TrueNAS prefers REST over HTTPS but supports SSH as a fallback, and Unraid is SSH-only (no usable HTTPS API for our needs and no MCP server). The pool sits in front of all six subclasses uniformly.

After this spec, the connection layer is feature-complete for all six platform types. SPEC-001-2-04 wires the CLI; SPEC-001-2-05 adds tests.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/connection/unifi.ts` | Create | HTTPS bearer-token only |
| `plugins/autonomous-dev-homelab/src/connection/truenas.ts` | Create | REST first, SSH fallback (no MCP) |
| `plugins/autonomous-dev-homelab/src/connection/unraid.ts` | Create | SSH only (no MCP, no REST) |
| `plugins/autonomous-dev-homelab/src/connection/https-client.ts` | Create | Tiny wrapper around `fetch` for bearer-token + token + JSON |
| `plugins/autonomous-dev-homelab/src/connection/pool.ts` | Create | `ConnectionPool` with idle TTL, capacity cap, shutdown |
| `plugins/autonomous-dev-homelab/src/connection/factory.ts` | Create | `createConnection(platformId, inventoryEntry, deps)` switch |

## Implementation Details

### `src/connection/https-client.ts`

```ts
export interface HTTPSCredentials {
  baseUrl: string;          // e.g. https://unifi.lan:8443
  bearerToken?: string;
  apiKey?: string;          // header X-API-Key
  insecure?: boolean;       // allow self-signed (default false)
}

export class HTTPSClient {
  constructor(creds: HTTPSCredentials);
  async get(path: string, opts?: { timeoutMs?: number }): Promise<{ status: number; body: unknown }>;
  async post(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<{ status: number; body: unknown }>;
  isConfigured(): boolean;
}
```

Uses Node's built-in `fetch` (Node ≥ 18). When `insecure: true`, attaches an `https.Agent({ rejectUnauthorized: false })` and **logs a warning every connect** so operators don't forget. Request timeout enforced via `AbortSignal.timeout(timeoutMs)`. JSON request/response bodies are auto-encoded/decoded; non-JSON responses return `body: <string>`.

### `src/connection/unifi.ts`

```ts
export class UnifiConnection extends Connection {
  // connect(): skips tryMCP. Performs HTTPS preflight (`GET /api/self`) to verify token.
  // capabilities = { transport: 'https', hostname, certFingerprint: undefined }
  // exec(command): NOT a shell exec. The `command` parameter is parsed as a JSON-encoded
  //                {method, path, body?} structure; HTTPS request is dispatched.
  //                Plain shell strings cause `exec` to throw UnsupportedExecError.
  // disconnect(): no-op (HTTPS is request-scoped)
}
```

UniFi controllers do not expose SSH. The "exec" abstraction is preserved by treating the command as a structured HTTPS request descriptor. Higher layers (CLI, fault probes) call `exec(JSON.stringify({ method: 'GET', path: '/api/s/default/stat/health' }))`; this keeps the `Connection` interface uniform across transports.

### `src/connection/truenas.ts`

REST-first, SSH-fallback. Tries HTTPS preflight against `/api/v2.0/system/info`; on failure (timeout, 401/403, network), falls back to SSH using cert auth. Same `exec` semantics as Proxmox/Docker/K8s when SSH is the active transport. When REST is active, `exec` accepts the same JSON-encoded HTTPS-descriptor convention as `UnifiConnection`. Capability reflects the active transport.

### `src/connection/unraid.ts`

SSH-only. `connect()` skips both `tryMCP()` and any HTTPS attempt; goes straight to `fallbackSSH()` from SPEC-001-2-02's pattern. `exec` is a normal shell exec.

### `src/connection/pool.ts`

```ts
export interface ConnectionPoolOptions {
  idleTimeoutMs?: number;       // default 5 * 60 * 1000
  maxConnections?: number;      // default 50
  reapIntervalMs?: number;      // default 30 * 1000
}

export class ConnectionPool {
  constructor(opts: ConnectionPoolOptions, factory: ConnectionFactory);
  async getConnection(platformId: string): Promise<Connection>;
  async release(platformId: string): Promise<void>;          // marks idle (does not close)
  async closeAll(): Promise<void>;                            // for shutdown
  size(): number;
  startReaper(): void;                                        // begins setInterval-based idle sweep
  stopReaper(): void;
}
```

Behavior:
- `getConnection(id)`: if a live, non-stale connection exists, update `lastUsedAt`, return it. Otherwise, factory-creates one, calls `connect()`, stores in the pool, returns it.
- An in-flight `connect()` for a given platform-id is deduplicated via a per-id promise map; concurrent `getConnection` calls await the same connect.
- Pool is capped at `maxConnections`. When full and a new id is requested, the LRU connection is closed.
- The reaper runs every `reapIntervalMs`; closes connections with `lastUsedAt < now - idleTimeoutMs`. Closing tolerates `disconnect()` failures (logs warning, drops from pool either way).
- `closeAll()` is called by the daemon shutdown handler.

### `src/connection/factory.ts`

```ts
export type Platform = 'proxmox' | 'docker' | 'k8s' | 'unifi' | 'truenas' | 'unraid';

export interface InventoryEntry {
  platform: Platform;
  hostname: string;
  connection: { /* hostname, port, ssh_user, ssh_cert_path, ssh_key_path, https_token, prefer? */ };
}

export type ConnectionFactory = (platformId: string, entry: InventoryEntry, deps?: FactoryDeps) => Connection;

export const createConnection: ConnectionFactory;
```

A switch on `entry.platform` instantiates the correct subclass with credentials wired from the inventory entry. `deps` allows injection of `MCPClient` / `SSHClient` / `HTTPSClient` for tests.

## Acceptance Criteria

- [ ] `UnifiConnection`, `TrueNasConnection`, `UnraidConnection` each extend abstract `Connection` and compile under `tsc --strict`.
- [ ] `UnifiConnection.connect()` does NOT call `tryMCP`; it performs the HTTPS preflight against `/api/self` and sets `capabilities.transport === 'https'` on success.
- [ ] `UnifiConnection.exec('not json')` throws `UnsupportedExecError` with a message explaining the JSON-descriptor convention.
- [ ] `UnifiConnection.exec(JSON.stringify({method:'GET',path:'/api/self'}))` returns `ExecResult` with `stdout` containing the JSON body, `exitCode === 0` for HTTP 2xx, `exitCode === <status>` (mapped) for HTTP errors.
- [ ] `TrueNasConnection` tries REST first; on REST failure, falls back to SSH; capability reports the active transport.
- [ ] `UnraidConnection.connect()` skips REST/MCP entirely; SSH is the only transport; capability reports `transport: 'ssh'`.
- [ ] `HTTPSClient` honors `timeoutMs` per request via `AbortSignal.timeout`.
- [ ] `HTTPSClient` emits a warning log line each time `insecure: true` is used.
- [ ] `ConnectionPool.getConnection('p1')` returns the same instance on a second call within `idleTimeoutMs` (verified by reference equality).
- [ ] `ConnectionPool.getConnection('p1')` after `idleTimeoutMs + 1ms` returns a NEW instance (the previous one was reaped); previous instance's `disconnect()` was called exactly once.
- [ ] Concurrent `getConnection('p1')` calls (10 in parallel before connect resolves) result in exactly ONE `connect()` invocation; all callers receive the same instance.
- [ ] When pool is at `maxConnections` and a new platform-id is requested, the LRU entry is evicted (closed) and the new one is created.
- [ ] `closeAll()` calls `disconnect()` on every pool entry; tolerates per-entry failures and continues.
- [ ] `startReaper()` / `stopReaper()` are idempotent.
- [ ] `createConnection` returns the correct subclass for each `platform` value; throws `UnknownPlatformError` for unrecognized values.
- [ ] Pool tests use a fake `Connection` factory and `vi.useFakeTimers()` (or jest equivalent) to control idle/reaper timing deterministically.
- [ ] No subclass leaks credentials in error messages or logs (verified by inspecting log spy output for known token fixtures).

## Dependencies

- **SPEC-001-2-01** (blocking): abstract `Connection`, `ExecResult`, `ConnectionCapabilities`.
- **SPEC-001-2-02** (blocking): `SSHClient`, `MCPClient`, `errors.ts`. TrueNAS and Unraid SSH paths reuse `SSHClient`.
- **PLAN-001-1**: inventory entry shape (`InventoryEntry`).
- **External**: Node ≥ 18 (`fetch`, `AbortSignal.timeout`). No new npm dependencies.
- **Consumed by**: SPEC-001-2-04 (CLI uses pool + factory), SPEC-001-2-05 (per-subclass + pool tests).

## Notes

- The "exec is JSON-descriptor on HTTPS transports" pattern is unusual but justified: it keeps the `Connection` interface single-shape across all six platforms. Without it, callers would need to type-narrow on `getCapabilities().transport` before every call. The cost is a small adapter at the call site (the upcoming fault probes in PLAN-002 know which descriptor to send for each platform).
- `UnifiConnection` does NOT implement UniFi's API token bootstrap (operator obtains the token out-of-band and stores it in inventory). The connection just consumes the token; bootstrap is operator-driven.
- TrueNAS Scale and TrueNAS CORE use the same REST API surface for the operations we care about (system info, dataset stats); subclass does not branch on variant.
- Unraid: HTTPS UI uses session cookies generated via web form login, which is not a stable contract. SSH-only is the conservative choice. Operators must enable SSH on Unraid (default in recent versions).
- The pool reaper interval (default 30s) is half the idle timeout's tenth — it strikes a balance between responsiveness and CPU. Configurable via `ConnectionPoolOptions`.
- Eviction is strict LRU. We do not weight by transport cost (MCP cold-starts are slower than SSH); the assumption is that platform churn within a 50-platform pool is rare enough that LRU is sufficient. Revisit if TDD-002 fault-probe load reveals churn.
- `release()` exists for symmetry but is essentially a no-op in v1: callers don't need to release because the reaper handles idle cleanup. We expose it so future code can mark connections as "definitely done" for eager close (e.g., after a known-final exec).
- Pool capacity (`maxConnections=50`) matches the Risks section of the parent plan. If TDD-002 fault probes hit this cap during steady-state operation, raise to 100; current default is conservative.
