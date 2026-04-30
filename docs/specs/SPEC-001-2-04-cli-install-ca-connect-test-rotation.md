# SPEC-001-2-04: `platform install-ca` + `platform connect-test` CLI + Key Rotation Flow

## Metadata
- **Parent Plan**: PLAN-001-2 (Connection Layer + SSH Certificate Authority)
- **Parent TDD**: TDD-001-platform-discovery-connection (§8 Connection, §9 SSH CA)
- **Tasks Covered**: Task 7 (`platform install-ca`), Task 8 (`platform connect-test`), Task 11 (key rotation)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-2-04-cli-install-ca-connect-test-rotation.md`

## Description
Wires the connection layer and SSH CA from the previous specs into operator-facing CLI subcommands and completes the key-rotation flow that SPEC-001-2-01 stubbed. After this spec, an operator can: discover platforms (PLAN-001-1), initialize a CA (existing infra), produce a CA pubkey for distribution (`platform install-ca`), verify connectivity (`platform connect-test`), and rotate a compromised platform key (`platform rotate-key`). This is the operational closing-of-the-loop for the connection layer.

The CLI commands live under a new `platform` subcommand group on the existing `autonomous-dev-homelab` CLI binary. They are designed to be safe to run repeatedly and produce both human-readable and JSON output.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/cli/commands/platform.ts` | Create | `install-ca`, `connect-test`, `rotate-key` subcommands |
| `plugins/autonomous-dev-homelab/src/cli/index.ts` | Modify | Register `platform` command group |
| `plugins/autonomous-dev-homelab/src/cli/output.ts` | Create | Shared `--json` formatter helper (or extend existing) |
| `plugins/autonomous-dev-homelab/src/ca/manager.ts` | Modify | Replace `rotateKey` stub with real implementation |
| `plugins/autonomous-dev-homelab/src/ca/manager.ts` | Modify | Add `generateKRL()` helper (Key Revocation List for distribution) |
| `plugins/autonomous-dev-homelab/tests/cli/platform.test.ts` | Create | Subcommand tests with mocked CA + pool |

## Implementation Details

### CLI Command Surface

All commands accept `--json` for machine-readable output and exit non-zero on failure.

#### `autonomous-dev-homelab platform install-ca <platform-id>`

Outputs the CA public key plus copy-paste instructions tailored to the platform's OS.

Human output (default):
```
Add the following two lines to /etc/ssh/sshd_config on proxmox-01:

    TrustedUserCAKeys /etc/ssh/homelab_ca.pub
    RevokedKeys      /etc/ssh/homelab_ca.krl

Then write the CA public key to /etc/ssh/homelab_ca.pub:

ssh-ed25519 AAAAC3Nz... homelab-ca

Restart sshd: systemctl restart sshd

For automated distribution see the KRL helper:
  autonomous-dev-homelab platform install-ca proxmox-01 --krl > homelab_ca.krl
```

JSON output (`--json`):
```json
{
  "platform_id": "proxmox-01",
  "ca_public_key": "ssh-ed25519 AAAAC3Nz... homelab-ca",
  "sshd_config_lines": [
    "TrustedUserCAKeys /etc/ssh/homelab_ca.pub",
    "RevokedKeys /etc/ssh/homelab_ca.krl"
  ],
  "remote_paths": {
    "ca_pubkey": "/etc/ssh/homelab_ca.pub",
    "krl": "/etc/ssh/homelab_ca.krl"
  }
}
```

`--krl` flag emits binary KRL (Key Revocation List) on stdout (suitable for `> homelab_ca.krl`).

#### `autonomous-dev-homelab platform connect-test <platform-id>`

Opens a connection via the pool, runs `whoami` (or HTTPS `/api/self` for HTTPS-only platforms), reports result. Honors `--timeout <ms>` (default 15000).

Human output (success):
```
OK  proxmox-01  transport=ssh  user=root  cert_fingerprint=SHA256:abc123...  duration=842ms
```

Human output (failure):
```
FAIL  proxmox-01
  transport: ssh
  error:     SSHAuthError: All configured authentication methods failed
  cert:      /Users/.../keys/proxmox-01.cert (valid until 2026-05-06T12:00:00Z)
  hint:      Run `platform install-ca proxmox-01` to (re-)distribute the CA pubkey.
```

JSON output:
```json
{
  "platform_id": "proxmox-01",
  "ok": true,
  "transport": "ssh",
  "exec_result": { "stdout": "root\n", "stderr": "", "exitCode": 0, "durationMs": 842 },
  "capabilities": { "transport": "ssh", "hostname": "proxmox-01.lan", "user": "root", "certFingerprint": "SHA256:..." }
}
```

Exit codes: 0 on success, 1 on connect failure, 2 on usage error (unknown platform-id).

#### `autonomous-dev-homelab platform rotate-key <platform-id>`

Calls `SSHCertificateManager.rotateKey()`. Prints the new public key plus instructions for re-distribution. Honors `--force` to skip the "are you sure" prompt; when stdin is not a TTY, requires `--force`.

Human output:
```
Rotating key for proxmox-01...
  Old cert fingerprint: SHA256:old123...
  Old cert added to revocation list at <homelab-data>/ca/revocation.list

New keypair generated:
  Private key: <homelab-data>/keys/proxmox-01.key  (mode 0600)
  Cert:        <homelab-data>/keys/proxmox-01.cert (valid until 2026-05-06T12:00:00Z)

Next steps:
  1. Distribute the updated KRL: autonomous-dev-homelab platform install-ca proxmox-01 --krl > homelab_ca.krl
  2. Copy homelab_ca.krl to /etc/ssh/homelab_ca.krl on proxmox-01
  3. Restart sshd on proxmox-01: systemctl restart sshd
  4. Verify: autonomous-dev-homelab platform connect-test proxmox-01
```

### `SSHCertificateManager.rotateKey()` (Implementation)

Replaces the SPEC-001-2-01 stub. Atomicity is important: a half-rotated state where the old key is revoked but the new key isn't signed leaves the platform unreachable.

```ts
async rotateKey(platformId: string, passphrase: string): Promise<RotationResult> {
  // Phase 1: read existing cert, capture old fingerprint
  const oldCert = await this.readCert(platformId);   // throws if no cert exists
  const oldFingerprint = await this.fingerprint(oldCert.path);

  // Phase 2: generate new keypair + cert in temp filenames
  const tempKey = `keys/${platformId}.key.new`;
  const tempCert = `keys/${platformId}.cert.new`;
  await this.generateUserKey(tempKey);
  await this.signCertInternal(tempKey, platformId, oldCert.principal, oldCert.validityDays, passphrase, tempCert);

  // Phase 3: atomic rename (POSIX rename is atomic on same filesystem)
  await fs.rename(tempKey, `keys/${platformId}.key`);
  await fs.rename(tempCert, `keys/${platformId}.cert`);
  await fs.rename(tempKey + '.pub', `keys/${platformId}.pub`);

  // Phase 4: append old fingerprint to revocation list (still valid until KRL distributed)
  await this.appendRevocation(platformId, oldFingerprint, new Date());

  return { oldFingerprint, newFingerprint: await this.fingerprint(`keys/${platformId}.cert`), revokedAt: new Date() };
}
```

If Phase 2 throws, the old keypair is untouched (operator can retry). If Phase 3 partially succeeds (rare; same-FS rename failures are unusual), the manager logs a CRITICAL error and surfaces a message instructing the operator to manually inspect `keys/`.

### `generateKRL()` (Implementation)

Wraps `ssh-keygen -k -f revocation.list -s ca/homelab_ca.key -P <passphrase> > <output>`. Reads the revocation list, produces a binary KRL suitable for distribution. The `--krl` flag of `install-ca` calls this and pipes to stdout.

### CLI Wiring (`src/cli/index.ts`)

Register a new command group via the existing CLI framework (Commander, yargs, or whichever the homelab plugin uses; assume Commander for this spec):

```ts
import { platformCommand } from './commands/platform.js';
program.addCommand(platformCommand());
```

Inside `platform.ts`, the command group resolves shared dependencies once per invocation:
- `ConfigManager` (from PLAN-001-1) → `<homelab-data>` location
- `InventoryManager` (from PLAN-001-1) → platform lookup
- `SSHCertificateManager` (SPEC-001-2-01) → CA operations
- `PassphraseProvider` (SPEC-001-2-01) → for rotate-key
- `ConnectionPool` + factory (SPEC-001-2-03) → for connect-test

## Acceptance Criteria

- [ ] `autonomous-dev-homelab platform install-ca proxmox-01` exits 0 and prints the CA public key plus the documented sshd_config lines.
- [ ] `platform install-ca proxmox-01 --json` emits valid JSON with `platform_id`, `ca_public_key`, `sshd_config_lines`, `remote_paths` fields.
- [ ] `platform install-ca proxmox-01 --krl` writes binary KRL to stdout; `xxd` of output starts with the SSH KRL magic bytes (`SSHKRL`).
- [ ] `platform install-ca <unknown-id>` exits 2 with usage error referencing inventory.
- [ ] `platform connect-test proxmox-01` against a reachable platform exits 0 and prints `OK ... transport=...`.
- [ ] `platform connect-test <unreachable>` exits 1, prints `FAIL`, and includes a human-readable hint pointing to `install-ca`.
- [ ] `platform connect-test --timeout 1000` honors the timeout; an unresponsive platform fails within 1.5s wallclock (allow some test slack).
- [ ] `platform connect-test --json` emits structured result regardless of success/failure.
- [ ] `platform rotate-key proxmox-01` (with TTY) prompts "Are you sure? [y/N]"; on `y`, performs rotation. On `n`, exits 0 with no changes.
- [ ] `platform rotate-key proxmox-01 --force` skips the prompt.
- [ ] `platform rotate-key proxmox-01` without TTY and without `--force` exits 2 with "use --force in non-interactive mode".
- [ ] After rotation, `<homelab-data>/keys/proxmox-01.cert` is a different file (new fingerprint) and `revocation.list` has a new entry containing the old fingerprint.
- [ ] After rotation, `keys/proxmox-01.key` is the new private key (mode 0600); the old private key is overwritten (not retained — old certs in revocation list are sufficient for forensic review).
- [ ] If rotation Phase 2 fails (e.g., signing throws), old `.key` and `.cert` files are untouched (verified by checksumming before/after a forced failure).
- [ ] `rotateKey` requires the CA passphrase via `PassphraseProvider`; passphrase never appears in subprocess argv (uses `-P` only with `ssh-keygen` which reads from a process file descriptor or environment variable, NOT command-line — verify by inspecting `ps` output during a test rotation).
- [ ] `generateKRL()` produces a KRL that, when set as `RevokedKeys` on a fixture sshd, causes connections with the revoked cert to be rejected (covered as part of the integration test in SPEC-001-2-05).
- [ ] All three subcommands appear in `autonomous-dev-homelab platform --help` with one-line descriptions.

## Dependencies

- **SPEC-001-2-01** (blocking): `SSHCertificateManager` (rotate-key flow), `PassphraseProvider`.
- **SPEC-001-2-02** (blocking): `Connection` subclasses (Proxmox/Docker/K8s).
- **SPEC-001-2-03** (blocking): `ConnectionPool`, `createConnection` factory.
- **PLAN-001-1** (blocking): `ConfigManager`, `InventoryManager`. CLI commands look up platform connection details from inventory.
- **PRD-009** (autonomous-dev): admin role required for `rotate-key` (initialization is implied admin; we do NOT enforce a separate role check in this spec — that is enforced by autonomous-dev's existing role middleware in front of the daemon).
- **External**: `ssh-keygen` for KRL generation. Node ≥ 18.
- **Consumed by**: SPEC-001-2-05 (integration test for rotation + KRL).

## Notes

- The `--json` flag is mandatory for every subcommand because the homelab plugin will eventually be consumed by the portal (PLAN-013-x) over IPC, and structured output is non-negotiable there.
- Passphrase handling for `rotate-key`: we never pass the passphrase as an argv (visible in `ps`). `ssh-keygen` accepts the passphrase via `SSH_ASKPASS` (with `SSH_ASKPASS_REQUIRE=force` and `setsid`) on Linux/macOS; the `SSHCertificateManager.signCertInternal` method already encapsulates this. The acceptance criterion for "no plaintext in argv" is enforced via a test that snapshots the spawned process's argv.
- KRL distribution is deliberately manual. Auto-distribution requires the daemon to have `sudo` write access to `/etc/ssh/` on every platform — too much blast radius for v1. Future enhancement: a second `platform distribute-krl <id>` subcommand that uses the existing connection to copy the file in (PLAN-001-3).
- Rotation does NOT trigger a connect-test automatically. Operator runs it explicitly so they understand whether the platform-side KRL update succeeded.
- The "Phase 3 partial failure" case is essentially impossible on POSIX same-FS renames, but the CRITICAL log path exists because operators may have `<homelab-data>` on a network mount where atomic rename guarantees are weaker.
- We do not version-bump the CA on rotation; the CA itself is unchanged. Rotation only affects the per-platform user keypair. CA rotation is a separate, much larger flow (out of scope for v1).
- All three subcommands honor `AUTONOMOUS_DEV_HOMELAB_DATA` env var override for `<homelab-data>` to make tests hermetic.
- The "are you sure?" prompt on rotation includes the old fingerprint so the operator can sanity-check they're rotating the right cert.
