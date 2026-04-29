# PLAN-001-2: Connection Layer + SSH Certificate Authority

## Metadata
- **Parent TDD**: TDD-001-platform-discovery-connection
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: [PLAN-001-1]
- **Priority**: P0

## Objective
Implement the connection layer per TDD §8 with platform-specific subclasses (`ProxmoxConnection`, `DockerConnection`, `K8sConnection`, `UnifiConnection`, `TrueNasConnection`, `UnraidConnection`) that prefer MCP servers when available and fall back to SSH, and the operator-managed SSH Certificate Authority per TDD §9 with Ed25519 keys, encrypted CA private key, 7-day platform certs, and revocation list. Together these enable the daemon to execute commands on discovered platforms without storing long-lived credentials. MCP server discovery, audit log, and CLI commands are PLAN-001-3.

## Scope
### In Scope
- Abstract `Connection` class at `src/connection/base.ts` per TDD §8: `connect()`, `exec(command)`, `disconnect()`, `getCapabilities()`. Returns structured `{stdout, stderr, exitCode}`.
- Six platform-specific connection subclasses per TDD §8:
  - `ProxmoxConnection`: prefers `mcp-server-proxmox`, falls back to SSH
  - `DockerConnection`: prefers `mcp-server-docker` (when available), falls back to SSH (`docker` CLI)
  - `K8sConnection`: prefers `mcp-server-kubernetes`, falls back to SSH (`kubectl`)
  - `UnifiConnection`: HTTPS API only (no SSH on UniFi controllers); uses bearer token
  - `TrueNasConnection`: prefers REST API (HTTPS), falls back to SSH
  - `UnraidConnection`: SSH only (Unraid's web UI lacks programmatic API for our needs)
- Auto-selection logic: `connect()` first attempts MCP via `tryMCP()`, on failure (non-existent server, connection refused, auth fail) falls back to `fallbackSSH()`. Failure mode is logged.
- SSH client implementation using `node-ssh` library (or `ssh2-streams`) with Ed25519 cert authentication
- `SSHCertificateManager` class at `src/ca/manager.ts` per TDD §9: `initializeCA(passphrase)`, `signPlatformCert(platformId, validityDays)`, `revokeKeys(platformId)`, `rotateKey(platformId)`
- CA private key encrypted at rest with operator-supplied passphrase (PBKDF2 + AES-256-GCM)
- Platform user keys generated automatically when a cert is signed for a new platform; stored at `<homelab-data>/keys/<platform-id>.key`
- Cert validity: 7 days default (configurable per-platform via `inventory.yaml`'s `connection.cert_validity_days`)
- Revocation list at `<homelab-data>/ca/revocation.list`. Each entry: platform-id + key fingerprint + revocation timestamp.
- Platform-side setup helper: `autonomous-dev-homelab platform install-ca <platform-id>` outputs the CA public key for the operator to paste into the platform's `/etc/ssh/sshd_config` as `TrustedUserCAKeys`
- Connection caching: an open SSH/MCP connection per platform is reused for up to 5 minutes idle (configurable). After 5 min idle, connection closes and re-authenticates on next call.
- Cost estimation: each `exec` call estimates cost as ~$0.0001 (negligible) for telemetry only; not enforced.
- Unit tests per connection subclass: MCP success path, MCP failure → SSH fallback path, exec command result parsing, disconnect cleanup
- Integration test: real SSH connection to a fixture container running OpenSSH; verify cert auth and exec

### Out of Scope
- Network consent + platform fingerprinting + inventory schema -- delivered by PLAN-001-1
- MCP server discovery (which servers are installed?) -- PLAN-001-3
- Audit log of every exec call -- PLAN-001-3
- CLI commands beyond `platform install-ca` -- PLAN-001-3
- Active monitoring / fault detection -- TDD-002
- Per-platform fault probes -- PLAN-002-1
- Authentication of the CLI itself -- existing PRD-009
- Multi-factor auth for CA passphrase -- v1 is single-passphrase
- Hardware security module (HSM) for CA key -- future enhancement

## Tasks

1. **Author abstract `Connection` class** -- Create `src/connection/base.ts` with the abstract class per TDD §8. Define `ExecResult` type with `stdout`, `stderr`, `exitCode`, `durationMs`.
   - Files to create: `plugins/autonomous-dev-homelab/src/connection/base.ts`
   - Acceptance criteria: TypeScript compiles. Abstract methods are documented. JSDoc cross-references TDD §8.
   - Estimated effort: 1.5h

2. **Implement `SSHCertificateManager`** -- Create `src/ca/manager.ts` per TDD §9. CA initialization uses `ssh-keygen -t ed25519 -N <passphrase>`. Cert signing uses `ssh-keygen -s <ca-key> -I <id> -n <principal> -V +<days>d`.
   - Files to create: `plugins/autonomous-dev-homelab/src/ca/manager.ts`
   - Acceptance criteria: `initializeCA('mypass')` creates `<homelab-data>/ca/homelab_ca.key` and `.pub` with mode 0600/0644. CA already exists → throws. `signPlatformCert('proxmox-01', 7)` generates user key + cert at `<homelab-data>/keys/proxmox-01.{key,pub,cert}`. Cert validity is 7 days. `revokeKeys('proxmox-01')` appends to `revocation.list`. Tests use temp directories.
   - Estimated effort: 5h

3. **Implement CA passphrase encryption helper** -- The CA passphrase is required at every cert-signing operation. Operator can provide it via env var (`HOMELAB_CA_PASSPHRASE`), interactive prompt, or via the existing autonomous-dev secrets manager (PRD-007). Encryption-at-rest of the operator's stored passphrase uses AES-256-GCM with key derived from a system-bound secret (e.g., a per-host key file).
   - Files to create: `plugins/autonomous-dev-homelab/src/ca/passphrase.ts`
   - Acceptance criteria: Passphrase from env var works. Without env var, interactive prompt fires. Optional: stored passphrase decrypted on first use, cached in memory for the daemon's uptime. No plain-text passphrase on disk. Tests cover env, prompt, stored modes.
   - Estimated effort: 3h

4. **Implement `ProxmoxConnection`** -- Create `src/connection/proxmox.ts` per TDD §8. `connect()` attempts MCP via `MCPClient.connect("mcp-server-proxmox", {host})`. On failure, falls back to SSH using the cert from `inventory.connection.ssh_cert_path`. `exec` routes through whichever connected.
   - Files to create: `plugins/autonomous-dev-homelab/src/connection/proxmox.ts`
   - Acceptance criteria: With a mocked MCP client returning success, `tryMCP()` returns true. With MCP throwing, `fallbackSSH()` runs. Exec via SSH returns structured result. Tests cover MCP success, MCP failure → SSH success, both failures (throws). 
   - Estimated effort: 4h

5. **Implement `DockerConnection`, `K8sConnection`, `UnifiConnection`, `TrueNasConnection`, `UnraidConnection`** -- Each follows the same MCP-first pattern. UniFi and Unraid have specific tweaks (UniFi uses HTTPS API only; Unraid is SSH-only — no MCP attempt).
   - Files to create: 5 connection files under `plugins/autonomous-dev-homelab/src/connection/`
   - Acceptance criteria: Each subclass implements the abstract Connection. UnifiConnection's `connect()` skips MCP and uses HTTPS bearer token directly. UnraidConnection's `connect()` skips MCP entirely. Tests cover the connection paths for each.
   - Estimated effort: 8h

6. **Implement connection caching** -- A `ConnectionPool` at `src/connection/pool.ts` caches open connections per platform-id. On `getConnection(platformId)`, returns existing connection if open and idle <5 min; otherwise creates a new one. Idle timeout closes the connection.
   - Files to create: `plugins/autonomous-dev-homelab/src/connection/pool.ts`
   - Acceptance criteria: First call creates a connection. Second call within 5 min reuses. Sixth-minute call creates a new connection. Pool gracefully closes all on daemon shutdown. Tests use mocked connections with controllable timers.
   - Estimated effort: 3h

7. **Implement `platform install-ca` CLI subcommand** -- `autonomous-dev-homelab platform install-ca <platform-id>` outputs the CA public key for the operator to paste into the platform's `sshd_config`. Includes copy-paste-ready instruction text.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/platform.ts`
   - Acceptance criteria: `platform install-ca proxmox-01` prints the contents of `<homelab-data>/ca/homelab_ca.pub` plus instructions: "Add this line to `/etc/ssh/sshd_config` on proxmox-01: `TrustedUserCAKeys /etc/ssh/homelab_ca.pub`. Then restart sshd." Tests verify the output format.
   - Estimated effort: 1.5h

8. **Implement `platform connect-test <platform-id>` CLI** -- Diagnostic subcommand that opens a connection, runs a no-op command (e.g., `whoami`), and reports the result. Useful for verifying setup.
   - Files to modify: `plugins/autonomous-dev-homelab/src/cli/commands/platform.ts`
   - Acceptance criteria: Successful connection prints `OK: connected via mcp/ssh, whoami=<user>`. Failure prints diagnostic with the error chain. JSON mode emits structured result.
   - Estimated effort: 1.5h

9. **Unit tests per connection subclass** -- `tests/connection/test-proxmox.test.ts` etc. covering MCP success, MCP failure → SSH fallback, exec result parsing, disconnect cleanup.
    - Files to create: 6 test files (one per platform subclass)
    - Acceptance criteria: All tests pass. Coverage ≥90% per subclass. Mocked MCP and SSH clients for determinism.
    - Estimated effort: 6h

10. **Integration test: real SSH cert auth** -- `tests/integration/test-ssh-cert-auth.test.ts` that initializes a CA, signs a platform cert, sets up a fixture OpenSSH server (Docker container) accepting the CA's TrustedUserCAKeys, and verifies a SSH `exec` succeeds with the signed cert.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-ssh-cert-auth.test.ts`
    - Acceptance criteria: Test passes against a Docker test-container. Cert is verified end-to-end (CA → platform → real exec). Invalid cert (revoked or expired) is rejected by the server.
    - Estimated effort: 4h

11. **Implement key rotation flow** -- `SSHCertificateManager.rotateKey(platformId)` revokes the current cert and signs a new one. The operator must re-distribute the new public key (manual step documented).
    - Files to modify: `plugins/autonomous-dev-homelab/src/ca/manager.ts`
    - Acceptance criteria: Rotation generates a new keypair, signs a new cert, appends old cert fingerprint to revocation list. Old cert is rejected by the platform after revocation list propagates. Tests verify the rotation produces a new key pair.
    - Estimated effort: 2h

## Dependencies & Integration Points

**Exposes to other plans:**
- `Connection` abstract class and platform subclasses consumed by PLAN-001-3 (MCP discovery, CLI commands), PLAN-002-* (fault probes use connections), and any future plan that interacts with platforms.
- `SSHCertificateManager` reusable for any future signing workflow that needs SSH-based authentication.
- Connection pool pattern reusable for any future connection-heavy subsystem.
- `platform install-ca` CLI pattern reusable for future operator-setup workflows.

**Consumes from other plans:**
- **PLAN-001-1** (blocking): `ConsentManager` (consent required before connecting), `InventoryManager` (lookup platform connection details).
- TDD-007 / PLAN-007-X (autonomous-dev): config infrastructure for `<homelab-data>` location.
- PRD-009 (autonomous-dev): admin role for CA initialization and key rotation.

**Consumes from external:**
- `node-ssh` or `ssh2` for SSH client implementation.
- `ssh-keygen` (system binary) for cert signing.
- `mcp-client` (autonomous-dev's MCP integration) for MCP-over-stdio connections.

## Testing Strategy

- **Unit tests per subclass (task 9):** ≥90% coverage per file. Mocked MCP and SSH clients.
- **Integration test with real SSH (task 10):** Docker container running OpenSSH; verify cert auth end-to-end.
- **Negative tests:** Expired cert rejected, revoked cert rejected, wrong CA rejected.
- **Connection pool stress test:** 100 simultaneous getConnection calls; verify pool serializes correctly without leaking connections.
- **Manual smoke:** Real Proxmox + Docker hosts on a test network; verify discovery → install-ca → connect-test → exec works end-to-end.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CA private key compromised (e.g., via filesystem traversal exploit elsewhere in the daemon) | Low | Critical -- attacker can sign certs and gain root on all platforms | CA key encrypted at rest (AES-256-GCM with operator passphrase). Passphrase never stored in plaintext. Filesystem permissions 0600. Operator can move CA key to a hardware token (future enhancement). Operator guide warns: "if your daemon is compromised, rotate the CA". |
| Cert validity (7 days) is too short for operators with limited maintenance windows | Medium | Low -- frequent re-signing | Validity is configurable per-platform via `inventory.yaml`. Default 7d is conservative; operators can extend to 30d or 90d for stable platforms. Documented trade-off: longer validity = larger blast radius if compromised. |
| Revocation list is stored locally; platforms don't know about revoked keys until manual update | High | Medium -- revoked cert remains valid until next rotation | Documented limitation. Best practice: when revoking, also rotate (operator re-distributes new pub key). Future enhancement: OCSP-style live revocation check via the daemon. |
| MCP server connection fails silently (returns nothing) and SSH fallback isn't triggered | Low | Medium -- platform appears unreachable | `tryMCP()` has a 5-second timeout. After timeout, falls back to SSH. Tests verify the timeout behavior. |
| `node-ssh` library has a security vulnerability (e.g., timing attack in cert verification) | Low | High -- auth bypass | Pin to vetted version. Dependabot for security patches. CI smoke test exercises cert auth at least once per release. Alternative: switch to OpenSSH binary as a subprocess (more proven but slower). |
| Connection pool holds connections across long idle periods, accumulating resources | Medium | Low -- daemon memory pressure | 5-min idle timeout closes connections. Pool size capped at 50 platforms (configurable). Documented as a known characteristic. |

## Definition of Done

- [ ] Abstract `Connection` class + 6 platform subclasses compile under TypeScript strict
- [ ] `SSHCertificateManager` initializes CA, signs platform certs, revokes, rotates
- [ ] CA private key is encrypted at rest with operator passphrase
- [ ] Connection auto-prefers MCP when available, falls back to SSH cleanly
- [ ] Connection pool reuses connections for 5 min idle, closes after timeout
- [ ] `platform install-ca` and `platform connect-test` CLI subcommands work
- [ ] Unit tests pass with ≥90% coverage per connection subclass
- [ ] Integration test demonstrates SSH cert auth against a real OpenSSH fixture
- [ ] Revoked cert is rejected by the platform
- [ ] Key rotation flow produces a new keypair and revokes the old
- [ ] No regressions in PLAN-001-1 functionality
