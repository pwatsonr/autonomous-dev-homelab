# SPEC-001-3-03: audit + consent + ca CLI Subcommands

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 5 (audit verify/query CLI), Task 6 (consent list/grant/revoke CLI), Task 7 (ca init/rotate/list CLI)
- **Estimated effort**: 6.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-3-03-audit-consent-ca-cli.md`

## Description
Three CLI command groups on the operator-facing `autonomous-dev-homelab` binary, each fronting an existing manager from PLAN-001-1, PLAN-001-2, or SPEC-001-3-02. None of these commands introduce new business logic — they are operator surfaces for already-implemented functionality. They share a consistent shape: subcommands, `--json` output mode, structured stderr errors, and uniform exit codes (`0` success, `1` operator error, `2` internal error).

The admin-role authentication wrap is **defined here in scope** (which subcommands are destructive) but **enforced in SPEC-001-3-04** (single shared middleware). This spec must mark each destructive subcommand with the `requiresAdmin: true` flag in its definition so the wrap can pick them up.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/cli/commands/audit.ts` | Create | `audit verify` + `audit query` subcommands |
| `plugins/autonomous-dev-homelab/src/cli/commands/consent.ts` | Create | `consent list/grant/revoke` subcommands |
| `plugins/autonomous-dev-homelab/src/cli/commands/ca.ts` | Create | `ca init/rotate/list` subcommands |
| `plugins/autonomous-dev-homelab/src/cli/types.ts` | Modify | Add `requiresAdmin?: boolean` to `CommandDefinition` |
| `plugins/autonomous-dev-homelab/src/cli/index.ts` | Modify | Register the three new command groups |
| `plugins/autonomous-dev-homelab/tests/cli/test-audit-cli.test.ts` | Create | Verify clean + tampered + filtered queries |
| `plugins/autonomous-dev-homelab/tests/cli/test-consent-cli.test.ts` | Create | Verify list/grant/revoke output and audit emission |
| `plugins/autonomous-dev-homelab/tests/cli/test-ca-cli.test.ts` | Create | Verify init/rotate/list flows |

## Implementation Details

### `audit verify`

```
autonomous-dev-homelab audit verify [--json]
```

Walks the entire `<homelab-data>/audit.log` from line 1 to the last entry, recomputing each entry's HMAC and comparing with the stored value. Also verifies `seq` is monotonic with no gaps. On success, exits `0`. On any mismatch (HMAC mismatch or seq gap), exits `1`, identifies the first failing entry's `seq`, and emits a structured error.

Plain output:
```
audit log: 1247 entries verified, chain intact
```

`--json` output:
```json
{ "ok": true, "entries_verified": 1247, "first_seq": 1, "last_seq": 1247 }
```

Tampered output (exit 1):
```json
{ "ok": false, "entries_verified": 423, "failed_at_seq": 423, "reason": "hmac_mismatch" }
```

### `audit query`

```
autonomous-dev-homelab audit query [--platform <id>] [--event <type>]
                                   [--since <iso-ts>] [--actor <user>]
                                   [--limit <n>] [--json]
```

Streams the audit log, filtering each entry by every provided flag (logical AND). `--limit` defaults to 100; `0` means unlimited. Output is one entry per line in plain mode (compact human-readable), or a JSON array on stdout in `--json` mode.

Plain output (one line per entry):
```
2026-04-29T10:32:11.044Z  pwatson  proxmox-01  cert_signed  serial=4f2a... fingerprint=SHA256:...
```

`--json` output:
```json
[
  { "seq": 412, "timestamp": "2026-04-29T10:32:11.044Z", "actor": "pwatson", "platform": "proxmox-01", "event": "cert_signed", "payload": { "serial": "4f2a..." }, "hmac": "..." }
]
```

Filter parsing:
- `--since` accepts `YYYY-MM-DD` (interpreted as `00:00:00 UTC`) or full ISO-8601.
- `--event` is exact-match against the `event` field; unknown events return zero results without error.
- `--actor`, `--platform` are exact-match strings.

### `consent list`

```
autonomous-dev-homelab consent list [--json]
```

Calls `ConsentManager.listConsents()` (existing). Plain output is a fixed-width table:

```
CIDR              APPROVED_AT           EXPIRES_AT            PORTS                SCAN_TYPES
192.168.1.0/24    2026-04-28T14:21:00Z  2026-05-28T14:21:00Z  22,80,443,8006       tcp
10.0.0.0/16       2026-04-29T09:10:00Z  -                     22,80,443            tcp,arp
```

Empty list prints `No active consents.` (plain) or `[]` (json).

### `consent grant`

```
autonomous-dev-homelab consent grant <cidr> [--ports <list>] [--scan-types <list>]
                                            [--ttl <duration>] [--json]
```

Delegates to `ConsentManager.requestConsent` with the given args. Interactively prompts the operator (the manager's existing prompt flow); for CIDRs larger than `/24`, an extra confirmation showing the IP count is required (the manager already enforces this). On grant, prints the resulting consent record. Emits `consent_granted` audit entry (handled by manager per SPEC-001-3-02).

`--ports` defaults to `22,80,443,8006`. `--scan-types` defaults to `tcp`. `--ttl` accepts `30d`, `1h`, etc.; defaults to none (permanent).

### `consent revoke`

```
autonomous-dev-homelab consent revoke <cidr> [--json]
```

**Destructive — `requiresAdmin: true`.** Calls `ConsentManager.revokeConsent(cidr)`. Exits `1` with `Error: no active consent for <cidr>` if not found. On success: `Revoked consent for <cidr>.` (plain) or `{ "revoked": "<cidr>" }` (json). Emits `consent_revoked` audit entry (handled by manager).

### `ca init`

```
autonomous-dev-homelab ca init [--passphrase-file <path>] [--json]
```

**Destructive — `requiresAdmin: true`.** Calls `SSHCertificateManager.initializeCA()`. Interactively prompts for the passphrase unless `--passphrase-file` is supplied (file must be mode `0600`; spec rejects others with a clear error). On success: `CA initialized at <homelab-data>/ca/`. Emits `ca_initialized` audit entry (handled by manager). Refuses with exit `1` if a CA already exists; operator must run `ca rotate` instead.

### `ca rotate`

```
autonomous-dev-homelab ca rotate <platform-id> [--json]
```

**Destructive — `requiresAdmin: true`.** Calls `SSHCertificateManager.rotateCertificate(platformId)`. Revokes the existing cert for `platformId` and signs a fresh one. On success: `Rotated cert for <platform-id>; new serial: <serial>`. Emits `cert_revoked` then `cert_signed` audit entries (handled by manager). Exits `1` if `platform-id` is not in the inventory.

### `ca list`

```
autonomous-dev-homelab ca list [--json]
```

Lists every signed cert from the manager's records:

```
PLATFORM-ID    SIGNED_AT             EXPIRES_AT            STATUS
proxmox-01     2026-04-28T15:00:00Z  2026-05-28T15:00:00Z  active
unraid-01      2026-04-15T10:00:00Z  2026-05-15T10:00:00Z  revoked
```

Empty: `No certs signed.`

### Common Conventions

- All commands accept `--json`.
- All errors go to stderr; structured form is `{"ok":false,"error":"<msg>","code":"<token>"}` in `--json` mode.
- Exit codes: `0` success, `1` operator error (bad input, not found, not authorized), `2` internal error (unexpected exception).
- `--help` is generated by the CLI framework already in use (commander or yargs — match what PLAN-001-1's `discover.ts` uses).

### `requiresAdmin` Flag

```typescript
// In src/cli/types.ts (modify):
export interface CommandDefinition {
  name: string;
  description: string;
  requiresAdmin?: boolean;  // NEW: enforced by SPEC-001-3-04 middleware.
  handler: (args: ParsedArgs) => Promise<number>;
  // ...existing fields...
}
```

This spec **declares** the flag on each destructive subcommand. The actual enforcement (the middleware that calls into autonomous-dev's admin-role check) is in SPEC-001-3-04. If a Code Executor implements this spec without SPEC-001-3-04 in place, all subcommands work but admin enforcement is a no-op (this is acceptable; SPEC-001-3-04 will activate it).

Subcommands with `requiresAdmin: true`:
- `consent revoke`
- `ca init`
- `ca rotate`

(Subcommands like `audit verify`, `audit query`, `consent list`, `consent grant`, `ca list` are read-only or interactive-with-explicit-user-confirmation and do not require admin.)

## Acceptance Criteria

- [ ] `audit verify` exits `0` on a clean log; `1` on a log with one tampered entry; identifies the failing seq.
- [ ] `audit verify --json` emits the documented JSON shape on both success and failure.
- [ ] `audit query --platform proxmox-01 --since 2026-04-28` returns only entries matching both filters; results are in chronological order.
- [ ] `audit query --event command_executed --limit 5` returns at most 5 most-recent matching entries.
- [ ] `consent list` prints all active consents in the table shape; `--json` emits an array.
- [ ] `consent grant 192.168.1.0/24` calls `ConsentManager.requestConsent` and prints the resulting record.
- [ ] `consent grant 10.0.0.0/16` triggers the manager's large-CIDR confirmation (manager-side, this CLI just passes through).
- [ ] `consent revoke <cidr>` is marked `requiresAdmin: true`; removes the consent on success; exits `1` if no such consent.
- [ ] `ca init` is marked `requiresAdmin: true`; calls `SSHCertificateManager.initializeCA`; refuses with exit `1` if CA already exists.
- [ ] `ca rotate proxmox-01` is marked `requiresAdmin: true`; calls `rotateCertificate(platformId)`; exits `1` if platform unknown.
- [ ] `ca list` prints the cert table; `revoked` certs show `revoked` status.
- [ ] Every command supports `--json`; structured errors go to stderr with `code` token.
- [ ] Exit codes match the documented mapping (`0`, `1`, `2`).
- [ ] Unit tests for each command cover happy path + at least one error path.
- [ ] Audit-emission tests assert that `consent revoke`, `ca init`, `ca rotate` produce the expected audit entries (via SPEC-001-3-02's writer, with mocked file).

## Dependencies

- **Blocked by**: PLAN-001-1 (`ConsentManager`), PLAN-001-2 (`SSHCertificateManager`), SPEC-001-3-02 (audit writer must exist for `audit verify` / `audit query` to read).
- **Sister spec**: SPEC-001-3-04 enforces the `requiresAdmin` flag declared here.
- CLI framework already adopted by the homelab plugin (commander/yargs — must not introduce a new dependency).

## Notes

- The CLI is intentionally thin. Every subcommand is "parse args, validate, call manager, format output." Business logic stays in the managers; this keeps tests focused and the surface easy to extend (e.g., future `consent extend` is a 30-line addition).
- `audit query` is O(n) on the file size today. The plan's risk register notes a future index file (`audit.idx`) to accelerate; out of scope here. For 1M entries on SSD, query takes ~10s — acceptable for v1.
- `--json` output is line-buffered in `audit query` (one entry per line as it streams). This lets operators pipe to `jq` for ad-hoc filtering. Plain mode buffers fully and prints on completion (table alignment).
- `ca list` reads from the `SSHCertificateManager`'s persisted records, not by walking the certs themselves. If the records become corrupt, list shows what's there; reconciliation with on-disk certs is a future tool.
- The CLI does not validate that the operator's `<homelab-data>` is initialized — it relies on the underlying managers to surface clear errors if not. Documented in the operator guide.
