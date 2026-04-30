# SPEC-001-2-05: Per-Subclass Unit Tests + Real SSH Cert Auth Integration Test

## Metadata
- **Parent Plan**: PLAN-001-2 (Connection Layer + SSH Certificate Authority)
- **Parent TDD**: TDD-001-platform-discovery-connection (§8 Connection, §9 SSH CA)
- **Tasks Covered**: Task 9 (per-subclass unit tests), Task 10 (real SSH cert integration test)
- **Estimated effort**: 10 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-2-05-connection-tests-ssh-cert-integration.md`

## Description
Closes out PLAN-001-2 with the test suite that validates everything in SPEC-001-2-01 through -04. Two distinct layers: (1) six per-subclass unit test files that mock MCP/SSH/HTTPS clients and exercise success, fallback, and failure paths deterministically; (2) one integration test that spins up an OpenSSH container, configures it as a TrustedUserCAKey consumer, and verifies a real cert-authenticated `exec` end-to-end. The integration test is the "we believe this actually works" gate before PLAN-001-3.

After this spec, the connection layer is shippable. PLAN-001-3 layers MCP discovery and audit on top.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/connection/proxmox.test.ts` | Create | Unit tests: MCP success, MCP→SSH fallback, both-fail, exec, disconnect |
| `plugins/autonomous-dev-homelab/tests/connection/docker.test.ts` | Create | Same shape as proxmox.test.ts |
| `plugins/autonomous-dev-homelab/tests/connection/k8s.test.ts` | Create | Same shape |
| `plugins/autonomous-dev-homelab/tests/connection/unifi.test.ts` | Create | HTTPS-only path: preflight, exec(JSON), unsupported-exec error |
| `plugins/autonomous-dev-homelab/tests/connection/truenas.test.ts` | Create | REST first, SSH fallback paths |
| `plugins/autonomous-dev-homelab/tests/connection/unraid.test.ts` | Create | SSH-only path |
| `plugins/autonomous-dev-homelab/tests/connection/pool.test.ts` | Create | Pool reuse, eviction, dedup, reaper, closeAll |
| `plugins/autonomous-dev-homelab/tests/integration/test-ssh-cert-auth.test.ts` | Create | Real OpenSSH container; cert auth + revocation |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/sshd/Dockerfile` | Create | Minimal OpenSSH server image |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/sshd/sshd_config` | Create | TrustedUserCAKeys + RevokedKeys configured |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/sshd/entrypoint.sh` | Create | Generates host key, mounts CA pub & KRL, starts sshd -D |
| `plugins/autonomous-dev-homelab/tests/integration/helpers/sshd-container.ts` | Create | Test helper: start/stop docker container |

## Implementation Details

### Per-Subclass Unit Tests (Common Shape)

Each subclass test mocks the dependencies injected via constructor (`MCPClient`, `SSHClient`, `HTTPSClient`). No real network. Use `vi.mock` (Vitest) or `jest.mock`; the file headers should make the choice obvious. Suggested test plan per Linux-style subclass (Proxmox, Docker, K8s):

```ts
describe('ProxmoxConnection', () => {
  describe('connect()', () => {
    it('uses MCP transport when MCP server connects', async () => {
      const mcp = mockMCPClient({ connect: vi.fn().mockResolvedValue(undefined) });
      const ssh = mockSSHClient();
      const conn = new ProxmoxConnection({ ...creds, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('mcp');
      expect(ssh.connect).not.toHaveBeenCalled();
    });

    it('falls back to SSH when MCP throws', async () => {
      const mcp = mockMCPClient({ connect: vi.fn().mockRejectedValue(new MCPUnavailableError('not_installed')) });
      const ssh = mockSSHClient({ connect: vi.fn().mockResolvedValue(undefined) });
      const conn = new ProxmoxConnection({ ...creds, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
      expect(ssh.connect).toHaveBeenCalledOnce();
    });

    it('falls back to SSH when MCP times out', async () => { /* uses fake timers, advances 5s+1ms */ });
    it('throws SSHAuthError with attached mcpError when both fail', async () => { /* … */ });
    it('logs the MCP failure reason at debug level', async () => { /* uses log spy */ });
  });

  describe('exec()', () => {
    it('routes through MCP when MCP transport is active', async () => { /* … */ });
    it('routes through SSH when SSH transport is active', async () => { /* … */ });
    it('returns ExecResult with measured durationMs > 0', async () => { /* … */ });
    it('does not throw when remote command exits non-zero', async () => { /* … */ });
    it('throws ConnectionTimeoutError on per-call timeout', async () => { /* … */ });
  });

  describe('disconnect()', () => {
    it('is idempotent', async () => { /* connect, disconnect twice, no throw */ });
    it('marks isConnected() false', async () => { /* … */ });
  });
});
```

UniFi adapts: skip the MCP/SSH branches; tests `connect()` HTTPS preflight success/failure, `exec(JSON)` success, `exec('not json')` throws `UnsupportedExecError`. TrueNAS tests REST-success then SSH-fallback. Unraid tests SSH-only (no REST attempt).

Coverage target: ≥ 90% statement coverage per subclass file (enforced via the project's existing coverage config).

### Pool Tests (`pool.test.ts`)

```ts
describe('ConnectionPool', () => {
  it('reuses live connections within idle TTL', async () => { /* getConnection x2, ref equal */ });
  it('reaps and re-creates after idle TTL', async () => {
    vi.useFakeTimers();
    const c1 = await pool.getConnection('p1');
    vi.advanceTimersByTime(idleTimeoutMs + 1);
    pool.startReaper(); // or call reaper tick directly
    const c2 = await pool.getConnection('p1');
    expect(c2).not.toBe(c1);
    expect(c1.disconnect).toHaveBeenCalledOnce();
  });
  it('deduplicates concurrent getConnection calls', async () => {
    const factory = vi.fn(() => slowConnection());
    const promises = Array.from({ length: 10 }, () => pool.getConnection('p1'));
    await Promise.all(promises);
    expect(factory).toHaveBeenCalledOnce();
  });
  it('evicts LRU when at maxConnections', async () => { /* fill pool, request new, oldest closed */ });
  it('closeAll() disconnects every entry, tolerating per-entry failures', async () => { /* … */ });
  it('startReaper / stopReaper are idempotent', async () => { /* … */ });
});
```

### Integration Test (`test-ssh-cert-auth.test.ts`)

End-to-end flow against a real OpenSSH container:

1. **Setup phase** (`beforeAll`):
   - Create temp `<homelab-data>` directory.
   - Initialize CA: `await ca.initializeCA('test-passphrase')`.
   - Generate KRL (initially empty).
   - Build sshd container image (cached by digest if unchanged).
   - Start sshd container with mounted CA public key (read-only) and KRL (read-only), exposing port 2222 → ephemeral host port.
   - Wait for sshd readiness via TCP probe + `nc -zv` retry loop (max 30s).

2. **Test 1 — Valid cert authenticates successfully**:
   - Sign cert: `await ca.signPlatformCert('test-host', 7, 'root', 'test-passphrase')`.
   - Construct `SSHClient` with the signed cert paths.
   - Connect, exec `whoami`, expect `stdout === 'root\n'`, `exitCode === 0`.

3. **Test 2 — Expired cert is rejected by sshd**:
   - Sign cert with validity `-1d` (already expired): pass `-V -1d:+0d` to `signCertInternal`.
   - Attempt connect, expect `SSHAuthError`.

4. **Test 3 — Revoked cert is rejected by sshd**:
   - Sign a fresh cert.
   - Verify it works (connect + exec succeeds).
   - Revoke it: `await ca.revokeKeys('test-host')`.
   - Generate KRL: `await ca.generateKRL('/path/in/container/homelab_ca.krl')`.
   - HUP sshd inside the container so it re-reads RevokedKeys.
   - Attempt connect, expect `SSHAuthError`.

5. **Test 4 — Wrong-CA cert is rejected**:
   - Initialize a SECOND ephemeral CA.
   - Sign a cert with the second CA.
   - Attempt to connect to the container (which trusts only the first CA).
   - Expect `SSHAuthError`.

6. **Test 5 — Key rotation produces a working new cert**:
   - Initial cert works.
   - Call `ca.rotateKey('test-host', 'test-passphrase')`.
   - Old cert: still valid until KRL distributed; we do NOT update the container's KRL here.
   - New cert: connect with the new files, `whoami` succeeds.
   - Update container KRL with the post-rotation revocation list, HUP sshd.
   - Attempt connect with the OLD cert files (cached separately during the test) → expect `SSHAuthError`.

7. **Teardown** (`afterAll`):
   - Stop and remove container.
   - `tmp.dirSync` cleanup runs automatically.

### Fixture Container

`tests/integration/fixtures/sshd/Dockerfile`:
```dockerfile
FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /var/run/sshd \
 && useradd -m -s /bin/bash root || true
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

`tests/integration/fixtures/sshd/sshd_config`:
```
Port 22
PermitRootLogin yes
PasswordAuthentication no
PubkeyAuthentication yes
TrustedUserCAKeys /etc/ssh/homelab_ca.pub
RevokedKeys      /etc/ssh/homelab_ca.krl
LogLevel VERBOSE
UsePAM no
```

`tests/integration/fixtures/sshd/entrypoint.sh`:
```bash
#!/bin/sh
set -e
ssh-keygen -A
# CA pubkey and KRL are mounted in via -v
test -f /etc/ssh/homelab_ca.pub || { echo "Missing CA pubkey mount"; exit 1; }
test -f /etc/ssh/homelab_ca.krl || touch /etc/ssh/homelab_ca.krl
exec /usr/sbin/sshd -D -e
```

`tests/integration/helpers/sshd-container.ts` exports `startSshdContainer(caPubPath, krlPath): Promise<{ host, port, hup, stop }>`. Uses `child_process.execFile('docker', ...)`; gracefully skips the test (logs SKIP) when Docker is not available locally so non-CI developers can run unit tests without Docker.

## Acceptance Criteria

- [ ] Six per-subclass unit test files exist; all tests pass; per-file statement coverage ≥ 90%.
- [ ] Each Linux-style subclass test (Proxmox/Docker/K8s) covers: MCP-success, MCP-throws-fallback-to-SSH, MCP-timeout-fallback, both-fail, MCP-routed exec, SSH-routed exec, exec-non-zero-no-throw, per-call timeout, idempotent disconnect.
- [ ] UniFi test covers: HTTPS preflight success, preflight failure, `exec(JSON)` success, `exec('not json')` throws `UnsupportedExecError`, disconnect is no-op.
- [ ] TrueNAS test covers REST-first then SSH-fallback paths; capability reflects active transport.
- [ ] Unraid test covers SSH-only; no REST/MCP code paths invoked (verified via spy assertions).
- [ ] Pool test covers: reuse within TTL, reap after TTL, concurrent dedup, LRU eviction at cap, `closeAll` tolerates failures, idempotent reaper start/stop. All timer-based assertions use fake timers — no real waiting.
- [ ] No unit test makes a real network call (verified by network sandbox or by undefined-fetch spy that fails the test).
- [ ] No unit test depends on the host having `ssh-keygen` installed (CA tests are in the SPEC-001-2-01 suite, not here).
- [ ] Integration test `test-ssh-cert-auth.test.ts` builds the sshd container image and runs all 5 sub-tests successfully against the real container.
- [ ] Integration test exits 0 on a CI runner with Docker available; SKIPS (with a warning, exit 0) when Docker is not available.
- [ ] Expired-cert sub-test confirms sshd rejects the connection (verified by `SSHAuthError` thrown from `SSHClient.connect`).
- [ ] Revoked-cert sub-test confirms KRL takes effect after sshd HUP (verified by connection succeeding before revoke and failing after KRL update + HUP).
- [ ] Wrong-CA sub-test confirms cross-CA isolation: cert signed by ephemeral CA-2 fails against container trusting CA-1.
- [ ] Rotation sub-test confirms (a) new cert works immediately, (b) old cert still works until KRL distribution, (c) old cert fails after KRL distribution.
- [ ] Total integration test runtime under 60 seconds (excluding image build) on a typical dev machine; documented in test file header.
- [ ] All test files use the project's existing test framework (no new framework introduced); existing `npm test` / `npm run test:integration` commands run them.

## Dependencies

- **SPEC-001-2-01** through **SPEC-001-2-04** (all blocking): provides every class and CLI under test.
- **External**: Docker (for integration test only). `vitest` or `jest` (whichever the homelab plugin already uses). `tmp` (already a devDep from SPEC-001-2-01).
- **PLAN-001-1**: integration test does NOT exercise inventory/consent flows; uses raw paths to keep the cert-auth boundary the only thing under test.
- **CI**: integration test should run in a separate CI job (`test:integration`) so unit-test feedback stays fast. The job needs Docker-in-Docker or a Docker-enabled runner.

## Notes

- Splitting unit and integration tests across two test commands matches the existing project convention; `npm test` runs unit only, `npm run test:integration` runs everything. Document this in the test file header so contributors know which to run locally.
- The integration test deliberately uses `docker exec ... kill -HUP 1` to reload sshd between revocation tests rather than restarting the container — restarts lose host key state and add 5+ seconds per test.
- The fixture Dockerfile uses `debian:12-slim` (rather than `alpine:latest`) because Alpine's BusyBox `sshd` does not support the full set of OpenSSH options we exercise (e.g., `RevokedKeys` parsing differs).
- We do NOT cache the built image in CI artifacts — Docker's BuildKit layer cache covers the typical case, and the image is small (~80MB).
- The "old cert still works until KRL distributed" sub-test demonstrates the documented Risk in PLAN-001-2 (revocation lag). The test asserts the documented behavior, not a hypothetical future fix.
- A common failure mode during early implementation is sshd silently rejecting the cert because the `principal` in the cert (e.g., `root`) does not match the SSH user (e.g., `root`). The test surfaces this clearly via VERBOSE sshd logging captured into the test output on failure.
- This is the largest test-only spec in PLAN-001-2; the size reflects the security criticality. Cert auth that "looks" right but actually allows expired/revoked certs is a credential-bypass class of bug — the integration test exists specifically to prevent that.
- After this spec passes, PLAN-001-2's Definition of Done is fully met: every checklist item maps to one or more acceptance criteria across SPEC-001-2-01 through SPEC-001-2-05.
