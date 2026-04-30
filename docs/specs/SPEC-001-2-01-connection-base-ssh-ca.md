# SPEC-001-2-01: Abstract Connection Class + SSHCertificateManager + CA Passphrase Encryption

## Metadata
- **Parent Plan**: PLAN-001-2 (Connection Layer + SSH Certificate Authority)
- **Parent TDD**: TDD-001-platform-discovery-connection (§8 Connection Layer, §9 SSH CA)
- **Tasks Covered**: Task 1 (abstract `Connection`), Task 2 (`SSHCertificateManager`), Task 3 (passphrase encryption)
- **Estimated effort**: 9.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-2-01-connection-base-ssh-ca.md`

## Description
Establishes the security foundation for the entire connection layer: the abstract `Connection` class that every platform subclass extends, the `SSHCertificateManager` that mints short-lived Ed25519 user certificates from an operator-managed CA, and the passphrase helper that protects the CA private key at rest. After this spec, the daemon can mint a signed cert for any platform-id and produce a `{key, pub, cert}` triplet ready for distribution — but cannot yet open a connection (subclasses land in SPEC-001-2-02 / -03).

This is the most security-sensitive spec in PLAN-001-2. The CA private key is the root of trust for all platform access. It must never touch disk in plaintext, never be logged, and never be cached longer than the daemon's process lifetime. The passphrase helper enforces these invariants.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/connection/base.ts` | Create | Abstract `Connection` class, `ExecResult`/`ConnectionCapabilities` types |
| `plugins/autonomous-dev-homelab/src/ca/manager.ts` | Create | `SSHCertificateManager` (init, sign, revoke; rotate stub for SPEC-001-2-04) |
| `plugins/autonomous-dev-homelab/src/ca/passphrase.ts` | Create | `PassphraseProvider`: env, prompt, stored (AES-256-GCM) |
| `plugins/autonomous-dev-homelab/src/ca/types.ts` | Create | Shared types: `CertificateMetadata`, `RevocationEntry`, `PassphraseSource` |
| `plugins/autonomous-dev-homelab/tests/connection/base.test.ts` | Create | Compile + abstract surface tests |
| `plugins/autonomous-dev-homelab/tests/ca/manager.test.ts` | Create | CA init, sign, revoke; uses `tmp` dir |
| `plugins/autonomous-dev-homelab/tests/ca/passphrase.test.ts` | Create | env / prompt / stored modes |

## Implementation Details

### `src/connection/base.ts`

```ts
/**
 * Abstract connection contract per TDD-001 §8.
 * All platform subclasses (Proxmox, Docker, K8s, UniFi, TrueNAS, Unraid)
 * extend this and implement {tryMCP, fallbackSSH, doExec, doDisconnect}.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ConnectionCapabilities {
  transport: 'mcp' | 'ssh' | 'https';
  serverName?: string;       // e.g. 'mcp-server-proxmox'
  hostname: string;
  user?: string;
  certFingerprint?: string;  // Ed25519 fingerprint when ssh+cert
}

export abstract class Connection {
  protected connected = false;
  protected capabilities?: ConnectionCapabilities;
  protected lastUsedAt = 0;

  constructor(public readonly platformId: string) {}

  abstract connect(): Promise<void>;
  abstract exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  abstract disconnect(): Promise<void>;
  getCapabilities(): ConnectionCapabilities | undefined { return this.capabilities; }
  isConnected(): boolean { return this.connected; }
  getLastUsedAt(): number { return this.lastUsedAt; }
}
```

### `src/ca/manager.ts`

CA storage layout under `<homelab-data>/`:
```
ca/
  homelab_ca.key     mode 0600  Ed25519 private key (encrypted via -N <passphrase>)
  homelab_ca.pub     mode 0644  CA public key (operator distributes)
  revocation.list    mode 0600  one entry per line: <platform-id>\t<fp>\t<iso8601>
keys/
  <platform-id>.key   mode 0600  user private key (Ed25519, no passphrase)
  <platform-id>.pub   mode 0644
  <platform-id>.cert  mode 0644  ssh-keygen-signed certificate
```

Operations (each shells out to `ssh-keygen` from PATH; capture stderr; throw `CAError` with stderr on non-zero):

- `initializeCA(passphrase: string)` → fails if `homelab_ca.key` already exists. Runs `ssh-keygen -t ed25519 -f <ca-key> -N <passphrase> -C "homelab-ca"`. Sets file modes explicitly after creation (do not rely on umask).
- `signPlatformCert(platformId, validityDays = 7, principal = 'root', passphrase)` → if `<platform-id>.key` does not exist, generate it (`ssh-keygen -t ed25519 -f keys/<id>.key -N "" -C "<id>"`). Then sign: `ssh-keygen -s ca/homelab_ca.key -P <passphrase> -I <platform-id> -n <principal> -V +<days>d -z <serial> keys/<id>.pub`. Serial is monotonically increasing (persisted to `ca/serial.counter`).
- `revokeKeys(platformId)` → reads `<platform-id>.cert`, extracts fingerprint via `ssh-keygen -L -f`, appends `<platform-id>\t<fp>\t<iso>` to `revocation.list`. Does not delete files (operator may still need them for forensic review).
- `getCAPublicKey()` → returns `homelab_ca.pub` contents as string.
- `listCertificates()` → enumerates `keys/*.cert`, returns `CertificateMetadata[]` with platformId, principal, validBefore, fingerprint, revoked flag.
- `rotateKey(platformId, passphrase)` → stub that throws `'Not implemented; see SPEC-001-2-04'`. (Full impl in SPEC-001-2-04.)

Constructor takes `{ dataDir: string, ssh-keygen?: string }` so tests can inject a temp dir and swap the binary.

### `src/ca/passphrase.ts`

`PassphraseProvider` resolves the CA passphrase from one of three sources, in order:

1. **Env var** `HOMELAB_CA_PASSPHRASE` — used as-is when set.
2. **Stored** — encrypted blob at `<homelab-data>/ca/passphrase.enc`. Wrapped via AES-256-GCM with a key derived (PBKDF2-SHA256, 200_000 iterations, 16-byte salt) from a per-host secret read from `<homelab-data>/ca/host.key` (created on first use, mode 0600, 32 random bytes). Decrypt on first request, cache in process memory only.
3. **Interactive prompt** — TTY prompt via `readline` (no echo). Falls back to throwing `PassphraseUnavailableError` when stdin is not a TTY.

```ts
export type PassphraseSource = 'env' | 'stored' | 'prompt';

export interface PassphraseProvider {
  get(): Promise<{ passphrase: string; source: PassphraseSource }>;
  store(passphrase: string): Promise<void>;   // wraps + writes passphrase.enc
  clear(): void;                               // wipes in-memory cache
}
```

Hard rules:
- Plaintext passphrase MUST NOT be written to any log, file, or error message.
- Cached passphrase is held in a `Buffer` zeroed by `clear()` (called on `process.on('exit')`).
- `passphrase.enc` schema: `{ version: 1, kdf: 'pbkdf2-sha256', iterations: 200000, salt: <hex>, iv: <hex>, tag: <hex>, ciphertext: <hex> }`.

## Acceptance Criteria

- [ ] `src/connection/base.ts` exports an abstract `Connection` class with the documented signature and compiles under `tsc --strict`.
- [ ] `ExecResult` and `ConnectionCapabilities` exported from the same module; importable by subclasses without circular deps.
- [ ] `SSHCertificateManager.initializeCA('correct horse')` against an empty temp dir creates `ca/homelab_ca.key` (mode 0600) and `ca/homelab_ca.pub` (mode 0644).
- [ ] Calling `initializeCA` a second time throws `CAAlreadyExistsError`; the existing CA key is untouched.
- [ ] `signPlatformCert('proxmox-01', 7, 'root', 'correct horse')` produces `keys/proxmox-01.{key,pub,cert}`. The cert reports validity = 7 days via `ssh-keygen -L`.
- [ ] Signing for a platform-id whose `.key` exists reuses the existing private key (no key regeneration). Signing for a new platform-id generates a fresh key.
- [ ] Each signed cert has a unique, monotonically increasing serial; `ca/serial.counter` is updated atomically (write-temp-then-rename).
- [ ] `revokeKeys('proxmox-01')` appends one line to `revocation.list` containing platform-id, fingerprint, and ISO-8601 timestamp.
- [ ] `getCAPublicKey()` returns the exact bytes of `homelab_ca.pub`.
- [ ] `rotateKey()` throws with message referencing SPEC-001-2-04.
- [ ] `PassphraseProvider.get()` returns `{passphrase: 'env-pass', source: 'env'}` when `HOMELAB_CA_PASSPHRASE=env-pass` is set.
- [ ] With no env var and a valid `passphrase.enc`, `get()` decrypts and returns `source: 'stored'`. Result is cached: a second `get()` does not re-decrypt (verified via spy on `crypto.createDecipheriv`).
- [ ] With no env var and no stored blob, `get()` opens a TTY prompt; in test, this path is exercised via injectable readline interface.
- [ ] With no env var, no stored blob, and `process.stdin.isTTY === false`, `get()` throws `PassphraseUnavailableError`.
- [ ] `passphrase.enc` round-trips: `store('hunter2')` then a fresh provider's `get()` returns `'hunter2'` with `source: 'stored'`.
- [ ] `clear()` zeroes the in-memory passphrase buffer (verified via inspecting buffer bytes).
- [ ] No test asserts on or logs the plaintext passphrase value beyond the test's own expected fixture string.
- [ ] `tests/ca/manager.test.ts` and `tests/ca/passphrase.test.ts` use `tmp.dirSync({ unsafeCleanup: true })` and clean up.
- [ ] Coverage ≥ 90% for `manager.ts` and `passphrase.ts`.

## Dependencies

- **External binaries**: `ssh-keygen` (OpenSSH ≥ 8.0; required for `-t ed25519` cert signing). The manager does not bundle ssh-keygen; resolution is via PATH with optional override in the constructor.
- **Node built-ins**: `crypto`, `fs/promises`, `path`, `child_process`, `readline`, `os`.
- **npm**: `tmp` (devDependency, for tests). No new runtime deps.
- **PLAN-001-1**: `<homelab-data>` directory location resolution (provided by `ConfigManager`). This spec accepts `dataDir` as a constructor parameter; integration with `ConfigManager` happens in SPEC-001-2-04 CLI wiring.
- **Consumed by**: SPEC-001-2-02, -03, -04 (subclasses & CLI wiring), SPEC-001-2-05 (tests).

## Notes

- The CA passphrase model is intentionally conservative for v1: env-or-prompt-or-encrypted-blob. A future enhancement may delegate to OS keychain (Keychain on macOS, Secret Service on Linux) once we have a clear PRD, but it adds platform-specific code paths and is out of scope here.
- `ssh-keygen` emits the cert with serial `0` if `-z` is omitted. We always pass `-z` so the revocation list and operator audit can reference unique serials.
- The `serial.counter` write uses write-to-`.tmp` + `fsync` + `rename` to avoid torn writes on power loss between signings; a duplicate serial across two valid certs would break `ssh-keygen -k` revocation generation downstream.
- File modes are set explicitly via `fs.chmod` after creation rather than relying on `umask` (operators may have permissive umasks, especially in container environments).
- `revocation.list` uses tab-separated lines (no JSON) so it can be eyeballed and grep'd. The format is internal — operators consume the eventual `ssh-keygen -k -f revocation.list` KRL produced by SPEC-001-2-04.
- The abstract `Connection` class deliberately does not enforce a connection lifecycle state machine (`connecting`, `connected`, `disconnecting`). Subclasses self-police via the `connected` flag because their lifecycles diverge (e.g., UniFi has no persistent socket).
- Keep this spec narrow. The `rotateKey` stub is intentional so subclasses can compile and import the manager without waiting for SPEC-001-2-04.
