# SPEC-001-3-04: platform exec + inventory get/remove + Admin Auth Enforcement

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 8 (`platform exec` CLI), Task 9 (`inventory get` and `inventory remove`), Task 10 (admin-role enforcement on destructive subcommands)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-3-04-platform-exec-inventory-and-admin-auth.md`

## Description
Three changes that complete the operator-facing surface and lock it down. First, add `platform exec <id> -- <command>` to the existing `platform` command group as the operator's "shell" against an inventoried platform; every exec is privileged, so it requires admin and emits an audit entry. Second, extend the existing `inventory` command (PLAN-001-1) with `get <id>` (read-only inspection) and `remove <id>` (delete + revoke cert; admin-only). Third, add the shared admin-role middleware that activates the `requiresAdmin: true` flag declared in SPEC-001-3-03 and applied here, by calling into autonomous-dev PRD-009's role check.

The middleware is the linchpin: a single piece of code at the CLI dispatch boundary that intercepts every command, looks up `requiresAdmin`, and rejects with exit `1` and a clear message if the current operator lacks the role. No per-command "if not admin then bail" boilerplate.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/cli/commands/platform.ts` | Modify | Add `exec` subcommand; mark `requiresAdmin: true` |
| `plugins/autonomous-dev-homelab/src/cli/commands/inventory.ts` | Modify | Add `get` and `remove`; mark `remove` as `requiresAdmin: true` |
| `plugins/autonomous-dev-homelab/src/cli/middleware/admin-auth.ts` | Create | Reads `requiresAdmin`, calls PRD-009 role check, exits 1 on failure |
| `plugins/autonomous-dev-homelab/src/cli/dispatcher.ts` | Modify | Invoke admin-auth middleware before each command handler |
| `plugins/autonomous-dev-homelab/tests/cli/test-platform-exec.test.ts` | Create | Happy path, failed connection, audit emission |
| `plugins/autonomous-dev-homelab/tests/cli/test-inventory-get-remove.test.ts` | Create | Get prints record; remove revokes cert + emits audit |
| `plugins/autonomous-dev-homelab/tests/cli/test-admin-auth-middleware.test.ts` | Create | Each destructive subcommand rejects non-admin; admin succeeds |

## Implementation Details

### `platform exec`

```
autonomous-dev-homelab platform exec <platform-id> -- <command...> [--json] [--timeout <secs>]
```

**Destructive — `requiresAdmin: true`.** Resolves `platform-id` via `InventoryManager`; opens a connection via `ConnectionPool` (which auto-selects MCP if SPEC-001-3-01's `mcp_endpoint` is set, else SSH); runs the command; prints the result. Anything after `--` is the command (preserves spaces, quoting, flags).

Plain output (success):
```
$ whoami
root
exit: 0  duration: 142ms
```

`--json` output:
```json
{
  "ok": true,
  "platform_id": "proxmox-01",
  "command": "whoami",
  "stdout": "root\n",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 142
}
```

Failure cases:
- Unknown platform-id → exit `1`, `Error: no platform 'foo' in inventory`.
- Connection failed → exit `1`, structured error with `error_code` from the underlying transport. The `connection_failed` audit entry is emitted by the connection layer (SPEC-001-3-02).
- Command non-zero exit → exit `1`, the result is still printed (operator wants the output even on failure). The `command_executed` audit entry has `exit_code` = the actual exit.
- Timeout (default 60s, override with `--timeout`) → exit `1`, the connection is killed, audit entry shows `command_executed` with `exit_code: -1` and `error: timeout`.

The `command_executed` audit emission is handled by the connection layer (SPEC-001-3-02); this CLI command does not emit directly.

### `inventory get`

```
autonomous-dev-homelab inventory get <platform-id> [--json]
```

Read-only. Resolves `platform-id` via `InventoryManager.getPlatform(id)`. Prints the full record. Plain output is YAML-style:

```
id: proxmox-01
host: 192.168.1.50
platform: proxmox
fingerprint:
  product: proxmox-ve
  version: 8.1.4
  endpoint: https://192.168.1.50:8006
discovered_at: 2026-04-28T14:00:00Z
connection:
  transport_priority: [mcp, ssh]
  mcp_endpoint: mcp-server-proxmox
  ssh_user: claude-homelab
  ssh_port: 22
  ca_installed: true
```

`--json` emits the raw record. Exits `1` with `Error: no platform '<id>' in inventory` if not found.

### `inventory remove`

```
autonomous-dev-homelab inventory remove <platform-id> [--json] [--yes]
```

**Destructive — `requiresAdmin: true`.** Two-step:
1. Calls `SSHCertificateManager.revokeKeys(platformId)` to revoke the cert (emits `cert_revoked` per SPEC-001-3-02).
2. Calls `InventoryManager.removePlatform(platformId)` to delete the record.

Without `--yes`, prompts: `Remove platform 'proxmox-01' and revoke its cert? [y/N]`. With `--yes` (or `--json`), skips the prompt.

On success: `Removed proxmox-01; cert revoked.` (plain) or `{ "removed": "proxmox-01", "cert_revoked": true }` (json). On unknown id: exit `1`. If cert revocation fails but inventory removal would succeed, abort the whole operation (atomic semantics — do not leave inventory in a half-state).

Note: as documented in PLAN-001-3's risk register, this does NOT remove the CA pubkey from the platform's `TrustedUserCAKeys`. The cert is revoked (so signed certs are rejected), and the operator can manually clean up the pubkey. Print this hint after success in plain mode: `Note: the CA pubkey on the platform is NOT removed; remove it manually if desired.`

### Admin Auth Middleware

```typescript
// src/cli/middleware/admin-auth.ts
import { hasAdminRole } from '@autonomous-dev/auth'; // PRD-009 export.

export async function enforceAdminIfRequired(
  command: CommandDefinition,
  ctx: CommandContext,
): Promise<void> {
  if (!command.requiresAdmin) return;
  const isAdmin = await hasAdminRole(ctx.actor);
  if (!isAdmin) {
    process.stderr.write(`Authorization required: admin role\n`);
    process.exit(1);
  }
}
```

In `src/cli/dispatcher.ts`, the dispatch loop becomes:

```typescript
const cmd = resolveCommand(argv);
const ctx = buildContext();
await enforceAdminIfRequired(cmd, ctx);  // Bails out before handler if non-admin.
const exitCode = await cmd.handler(ctx);
process.exit(exitCode);
```

Behavior:
- `requiresAdmin === undefined` or `false` → no check, proceed.
- `requiresAdmin === true` and operator is admin → proceed.
- `requiresAdmin === true` and operator is NOT admin → exit `1` with the literal message `Authorization required: admin role` to stderr. No JSON-mode override; auth failure is a hard stop.
- The middleware does NOT emit an audit entry on auth failure (the command never ran). The blocked attempt is logged separately via PRD-009's existing audit channel.

### `requiresAdmin` Coverage Table

After this spec lands, the following subcommands have `requiresAdmin: true`:

| Command Group | Subcommand | Source |
|---------------|-----------|--------|
| `consent` | `revoke` | SPEC-001-3-03 |
| `ca` | `init` | SPEC-001-3-03 |
| `ca` | `rotate` | SPEC-001-3-03 |
| `inventory` | `remove` | This spec |
| `platform` | `exec` | This spec |

Not destructive (no admin requirement): `discover`, `inventory list/get`, `platform install-ca`, `platform connect-test`, `consent list/grant`, `ca list`, `audit verify/query`.

## Acceptance Criteria

- [ ] `platform exec proxmox-01 -- whoami` opens a connection, runs `whoami`, prints `root` and exit 0 (against mocked transport in tests).
- [ ] `platform exec` with an unknown platform-id exits `1` with `Error: no platform '<id>' in inventory`.
- [ ] `platform exec` against a platform with `mcp_endpoint` set chooses MCP transport; without it, chooses SSH (verified via spy on `ConnectionPool.getConnection`).
- [ ] `platform exec` with `--timeout 5` kills the connection at 5 seconds; the audit entry shows `exit_code: -1` and `error: timeout`.
- [ ] `inventory get proxmox-01` prints all fields of the platform record in YAML-like plain output; `--json` emits the raw record.
- [ ] `inventory get unknown-id` exits `1` with the not-found error.
- [ ] `inventory remove proxmox-01 --yes` revokes the cert and removes the record; plain output includes the pubkey-cleanup note.
- [ ] `inventory remove` without `--yes` prompts for confirmation; declining (e.g., empty input) aborts with exit `0` and no changes.
- [ ] If `revokeKeys` fails during `inventory remove`, the inventory is NOT modified (atomic abort).
- [ ] Each `requiresAdmin: true` subcommand, invoked by a non-admin, exits `1` with stderr `Authorization required: admin role` and the handler is not called (verified by spy).
- [ ] Each `requiresAdmin: true` subcommand, invoked by an admin, runs to completion.
- [ ] A non-admin invocation does NOT emit an audit entry (command never ran); the failed attempt is recorded by PRD-009's auth audit, not by this plugin's audit log.
- [ ] `discover`, `inventory list/get`, `consent list/grant`, `audit verify/query`, `ca list`, `platform install-ca`, `platform connect-test` all run for non-admin operators without rejection.
- [ ] Unit test for the middleware uses both an admin and a non-admin stub identity; covers all five `requiresAdmin: true` subcommands.

## Dependencies

- **Blocked by**: PLAN-001-1 (`InventoryManager`), PLAN-001-2 (`SSHCertificateManager`, `ConnectionPool`), SPEC-001-3-02 (audit emission from connection/exec layers), SPEC-001-3-03 (declares `requiresAdmin` flag on `consent revoke`, `ca init`, `ca rotate`).
- **Consumes from**: autonomous-dev PRD-009 (`hasAdminRole(actor)` export).
- No new external libraries.

## Notes

- The middleware lives at the **dispatcher** level, not the command-handler level. This ensures it cannot be forgotten on a new destructive subcommand: the engineer adds `requiresAdmin: true` and the wrap fires automatically. A CI lint (PLAN-001-3 risks/testing strategy) checks that every new subcommand whose name contains `revoke`, `remove`, `delete`, `rotate`, `init`, `exec` either has the flag or is explicitly allow-listed.
- `platform exec` is intentionally low-level. Operators wanting structured operations (e.g., "add a Proxmox VM") should use the per-platform helper agents (PLAN-002-2). `exec` is the escape hatch.
- The `--yes` flag on `inventory remove` enables scripted use (CI cleanup, batch rotations); operators using it interactively are expected to review the prompt the first few times.
- The CA pubkey cleanup limitation is a known compromise: doing it automatically requires the homelab plugin to retain SSH access to a platform we're trying to forget about. The audit log preserves what was on the platform; the operator can clean up at leisure.
- Authorization failures could be made an audit event in this plugin, but PRD-009 already does this in the autonomous-dev base. Duplicating would create two records of the same failure — keep the single source of truth in PRD-009's audit channel.
