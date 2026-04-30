# SPEC-001-2-02: Proxmox + Docker + Kubernetes Connection Subclasses

## Metadata
- **Parent Plan**: PLAN-001-2 (Connection Layer + SSH Certificate Authority)
- **Parent TDD**: TDD-001-platform-discovery-connection (§8 Connection Layer)
- **Tasks Covered**: Task 4 (`ProxmoxConnection`), part of Task 5 (`DockerConnection`, `K8sConnection`)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-2-02-proxmox-docker-k8s-connections.md`

## Description
Implements the three "MCP-first, SSH-fallback" connection subclasses for the most common compute platforms in a homelab: Proxmox VE, Docker hosts, and Kubernetes clusters. Each subclass extends the abstract `Connection` from SPEC-001-2-01, attempts an MCP server connection first, and falls back to SSH (with cert auth) when the MCP server is unavailable, unreachable, or rejects. After this spec, the daemon can run shell commands against any of these three platform types — but pool reuse, UniFi/TrueNAS/Unraid, and CLI wiring are still pending.

The MCP-first / SSH-fallback pattern is the load-bearing design choice: it keeps the daemon working when MCP servers haven't been installed yet (the common bootstrap case) while preferring the richer MCP API when available.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/connection/proxmox.ts` | Create | `ProxmoxConnection` (MCP via `mcp-server-proxmox`, SSH fallback) |
| `plugins/autonomous-dev-homelab/src/connection/docker.ts` | Create | `DockerConnection` (MCP via `mcp-server-docker`, SSH `docker` CLI fallback) |
| `plugins/autonomous-dev-homelab/src/connection/k8s.ts` | Create | `K8sConnection` (MCP via `mcp-server-kubernetes`, SSH `kubectl` fallback) |
| `plugins/autonomous-dev-homelab/src/connection/ssh-client.ts` | Create | Thin wrapper around `node-ssh` with cert-auth helper |
| `plugins/autonomous-dev-homelab/src/connection/mcp-client.ts` | Create | Thin wrapper around autonomous-dev's MCP client; injectable for tests |
| `plugins/autonomous-dev-homelab/src/connection/errors.ts` | Create | `MCPUnavailableError`, `SSHAuthError`, `ConnectionTimeoutError` |

## Implementation Details

### Common Subclass Pattern

Every subclass implements `connect()` as:

```ts
async connect(): Promise<void> {
  this.lastUsedAt = Date.now();
  try {
    await this.tryMCP();           // throws MCPUnavailableError on any failure
    return;                        // success path: capabilities.transport = 'mcp'
  } catch (err) {
    this.logger.debug('MCP unavailable, falling back to SSH', {
      platformId: this.platformId,
      error: err.message
    });
  }
  await this.fallbackSSH();        // throws SSHAuthError / ConnectionTimeoutError
}
```

`tryMCP()` has a hard 5-second timeout (configurable via `connection.mcp_timeout_ms` in inventory). On timeout, it throws `MCPUnavailableError('timeout')`. Exec routes through `this.transport` — either `this.mcpClient.call(...)` or `this.sshClient.execCommand(...)`.

### `src/connection/ssh-client.ts`

```ts
export interface SSHCertCredentials {
  host: string;
  port?: number;          // default 22
  username: string;
  privateKeyPath: string; // <homelab-data>/keys/<id>.key
  certPath: string;       // <homelab-data>/keys/<id>.cert
  knownHostsPath?: string; // optional; otherwise strict host key check disabled with warning
}

export class SSHClient {
  async connect(creds: SSHCertCredentials, timeoutMs = 10_000): Promise<void>;
  async execCommand(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  async disconnect(): Promise<void>;
  isConnected(): boolean;
}
```

Implementation uses `node-ssh` (≥ 13.x), passing `privateKey` (file contents), `passphrase` undefined (user keys are unencrypted; CA-signed cert provides auth). Cert path is set via the `OpenSSH-Cert` extension; `node-ssh` requires explicit handling — pass `cert: fs.readFileSync(certPath)` through to the underlying `ssh2` client config. Wraps the resulting `Client.exec` callback into the structured `ExecResult` (capture stdout, stderr, exit, measure wall-clock).

### `src/connection/mcp-client.ts`

```ts
export interface MCPCallResult { content: unknown; isError: boolean; }

export interface MCPClient {
  connect(serverName: string, params: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  call(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPCallResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
```

The default implementation delegates to autonomous-dev's MCP integration. For testing, subclasses accept an `MCPClient` via constructor injection. `connect()` rejects with `MCPUnavailableError('not_installed' | 'connection_refused' | 'auth_failed' | 'timeout')`.

### `src/connection/proxmox.ts`

```ts
export interface ProxmoxConnectionOptions {
  hostname: string;
  sshUser?: string;        // default 'root'
  sshPort?: number;        // default 22
  privateKeyPath: string;
  certPath: string;
  mcpClient?: MCPClient;   // injectable
  sshClient?: SSHClient;   // injectable
  logger?: Logger;
}

export class ProxmoxConnection extends Connection {
  // tryMCP: this.mcpClient.connect('mcp-server-proxmox', { host: this.opts.hostname }, 5000)
  //         capabilities = { transport: 'mcp', serverName: 'mcp-server-proxmox', hostname }
  // fallbackSSH: this.sshClient.connect({ host, username, privateKeyPath, certPath })
  //              capabilities = { transport: 'ssh', hostname, user, certFingerprint }
  // exec: routes via this.transport
}
```

When MCP exec is used, command is mapped to a structured tool call: `mcp.call('shell_exec', { command })`. The MCP server's response shape (`{stdout, stderr, exitCode}`) is normalized into `ExecResult` with `durationMs` measured at the call site.

### `src/connection/docker.ts`

Same pattern as `ProxmoxConnection`. MCP server name: `mcp-server-docker`. SSH fallback assumes the `docker` CLI is available on the remote host (sanity-checked on first `exec` only when the operator opts into validation; default is no preflight to keep startup fast).

A note on socket-mounted local Docker: this spec targets remote Docker hosts only (matches TDD-001). Local Docker socket access is out of scope.

### `src/connection/k8s.ts`

Same pattern. MCP server name: `mcp-server-kubernetes`. SSH fallback assumes `kubectl` is on PATH for the SSH user, with a kubeconfig at `~/.kube/config` (operator-configured outside this spec). Capability detection (`getCapabilities()`) reports `transport: 'mcp'` or `transport: 'ssh'`; no kubeconfig validation in this spec.

### `src/connection/errors.ts`

```ts
export class MCPUnavailableError extends Error {
  constructor(public readonly reason: 'not_installed' | 'connection_refused' | 'auth_failed' | 'timeout', message?: string);
}
export class SSHAuthError extends Error { constructor(message: string, public readonly cause?: Error); }
export class ConnectionTimeoutError extends Error { constructor(public readonly transport: 'mcp' | 'ssh', timeoutMs: number); }
```

All three extend `Error`, set `name` correctly, and preserve `cause` when the underlying library exposes one.

## Acceptance Criteria

- [ ] `ProxmoxConnection`, `DockerConnection`, `K8sConnection` each extend the abstract `Connection` from SPEC-001-2-01 and implement `connect`, `exec`, `disconnect`.
- [ ] All three compile under `tsc --strict`.
- [ ] `connect()` calls `tryMCP()` first; on resolve, sets `capabilities.transport === 'mcp'`. SSH fallback is not invoked.
- [ ] When `tryMCP()` rejects with `MCPUnavailableError`, `fallbackSSH()` is called. On success, `capabilities.transport === 'ssh'` and `capabilities.certFingerprint` is populated from the cert file.
- [ ] When both `tryMCP()` and `fallbackSSH()` reject, `connect()` throws the SSH error (preserves the most actionable failure for the operator).
- [ ] `tryMCP()` enforces a 5-second default timeout; an MCP server that hangs causes `MCPUnavailableError('timeout')` and triggers SSH fallback.
- [ ] `exec('whoami')` over SSH returns `ExecResult` with `stdout` containing the username, `exitCode === 0`, `durationMs > 0`.
- [ ] `exec('false')` returns `exitCode === 1` (does not throw); `exec('command-that-does-not-exist')` returns non-zero `exitCode` and stderr (does not throw).
- [ ] `exec` honors a per-call `timeoutMs` (default 60s, overridable per call). On timeout, throws `ConnectionTimeoutError` with `transport === this.capabilities.transport`.
- [ ] `disconnect()` is idempotent: calling twice does not throw. After disconnect, `isConnected()` returns false.
- [ ] `MCPClient` and `SSHClient` are injectable via constructor options; tests use mocks (no real SSH or MCP traffic in this spec's unit tests).
- [ ] `UnifiConnection` (HTTPS-only) is NOT in this spec; subclass exists in SPEC-001-2-03.
- [ ] No subclass logs the cert private key contents, even at debug verbosity.
- [ ] When `tryMCP` falls back, the debug log entry includes the platform-id, the MCP error reason, and a stable message format suitable for log-grep.
- [ ] The error chain on a "both transports failed" outcome is preserved: SSH error is the thrown error; MCP error is attached as `(err as any).mcpError` for diagnostic CLI use.

## Dependencies

- **SPEC-001-2-01** (blocking): provides the abstract `Connection`, `ExecResult`, `ConnectionCapabilities`, and CA-signed cert files at `<homelab-data>/keys/<id>.{key,cert}`.
- **PLAN-001-1**: `InventoryManager` provides per-platform `connection` config (hostname, ssh user, cert paths). This spec accepts those values via constructor options; CLI/inventory wiring is in SPEC-001-2-04.
- **External**: `node-ssh` (≥ 13.x), `ssh2` (transitive). Pin versions in `package.json`. Dependabot watches for security updates.
- **autonomous-dev**: MCP client primitives. The wrapper in `mcp-client.ts` adapts the upstream API surface; if upstream changes, only that file is touched.
- **Consumed by**: SPEC-001-2-03 (other subclasses extend the same patterns), SPEC-001-2-04 (CLI uses these subclasses), SPEC-001-2-05 (per-subclass tests).

## Notes

- The MCP-first decision is reversible per-platform via inventory: `connection.prefer: 'ssh'` will skip `tryMCP()`. This is a future inventory-schema enhancement (PLAN-001-3); not implemented here, but the subclasses must accept an `opts.preferTransport?: 'mcp' | 'ssh'` parameter so the wiring is ready.
- We deliberately do NOT preflight the remote `docker` / `kubectl` CLI at connect time. Doing so adds 1-2 seconds to every cold connect and surfaces errors more naturally on the first real exec.
- `node-ssh`'s `Client.connect` accepts a `tryKeyboard: false` setting; we set it to false explicitly to ensure cert auth failures don't silently fall through to interactive auth in environments where stdin is attached.
- Known gotcha: `ssh2`'s OpenSSH cert support is enabled by passing the cert as a separate `cert` option in the connection config; passing it as the `privateKey` value alone causes the library to ignore it. The wrapper enforces this by reading both files and constructing the right shape.
- This spec ships the three "Linux server" subclasses. Network appliances (UniFi) and storage appliances (TrueNAS, Unraid) follow in SPEC-001-2-03 because their transport assumptions differ.
- We do not implement connection caching here. Each `connect()` opens a fresh transport. SPEC-001-2-03's `ConnectionPool` adds reuse.
- `getCapabilities()` returning `undefined` before `connect()` is intentional; subclasses populate it inside `tryMCP` / `fallbackSSH` only after the transport is verified open.
