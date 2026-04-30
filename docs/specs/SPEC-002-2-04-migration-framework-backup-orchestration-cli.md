# SPEC-002-2-04: Migration Schema, MigrationOrchestrator, Backup Verification, Gate Wiring, and Safety/Cancel-Action/Migrations CLI

## Metadata
- **Parent Plan**: PLAN-002-2 (Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration)
- **Tasks Covered**: Task 7 (migration schema/types), Task 8 (MigrationOrchestrator), Task 9 (backup verification), Task 10 (wire backup into gateApproval), Task 11 (safety/cancel-action/migrations CLI)
- **Future Home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-2-04-migration-framework-backup-orchestration-cli.md`
- **Estimated effort**: 13.5 hours

## Description
Implement the migration framework, backup verification, and operator-facing CLI commands that close the safety loop opened by SPEC-002-2-01 and SPEC-002-2-02. This is the largest spec in the plan because the four pieces are tightly coupled: the migration orchestrator drives architectural changes, those changes require backup verification, the backup verifier is wired into `gateApproval`, and operators interact with all of it through three CLI subcommands.

**Migration framework (TDD §10):** A declarative `Migration` plan schema (validated by JSON schema) describes a multi-phase migration (e.g., Portainer → K3s). The `MigrationOrchestrator` iterates phases — `identify-resources` → `plan-target` → `dry-run` → `approval-delay` (24h) → `execute` — persisting state at each transition so a daemon restart resumes mid-flight. Migrations are always classified `architectural`; their delay phase reuses `scheduleDelayedAction` from SPEC-002-2-02.

**Backup verification (TDD §11):** Reads `<homelab-data>/backup-manifest.json`. Each entry is HMAC-signed (operators' backup tooling co-signs with the same secret as SPEC-002-2-02). Per-platform freshness rules are configurable: ZFS pools < 24h, container images < 7d, etc. `verifyBackup({platform, target})` returns `{ok: true, manifest_entry}` or throws `BackupRequiredError`. Stale and missing both throw.

**Gate wiring (Task 10):** `requestDataAffectingApproval` and `requestArchitecturalApproval` in `gate.ts` (SPEC-002-2-01) gain a backup-verification call BEFORE the typed-CONFIRM prompt. Failure rejects with `BackupRequiredError`. Admin operators may pass `--skip-backup-check` (audit-logged, requires admin role).

**CLI:** Three subcommands of the existing `homelab` CLI binary. `safety check <action-id>` previews destructiveness/floor/required-approvals. `cancel-action <id>` cancels a pending action (delegates to `cancelDelayedAction` from SPEC-002-2-02). `migrations status [--id <id>]` lists in-flight migrations with current phase and remaining time.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/migration/types.ts` | Create | `Migration`, `MigrationPhase`, `MigrationState` interfaces |
| `plugins/autonomous-dev-homelab/schemas/migration-v1.json` | Create | JSON Schema for Migration; validates TDD §10 example |
| `plugins/autonomous-dev-homelab/src/migration/orchestrator.ts` | Create | `MigrationOrchestrator` class; phase iteration + state persistence |
| `plugins/autonomous-dev-homelab/src/migration/state-store.ts` | Create | HMAC-signed migration state I/O (reuses `signPayload`/`verifyPayload`) |
| `plugins/autonomous-dev-homelab/src/backup/types.ts` | Create | `BackupManifestEntry`, `FreshnessRule`, `BackupVerificationResult` |
| `plugins/autonomous-dev-homelab/src/backup/orchestrator.ts` | Create | `verifyBackup({platform, target})`; reads manifest, applies freshness rules |
| `plugins/autonomous-dev-homelab/src/backup/freshness-rules.ts` | Create | Per-platform freshness defaults (configurable via OperatorConfig) |
| `plugins/autonomous-dev-homelab/src/safety/gate.ts` | Modify | Add `verifyBackup` call to data-affecting + architectural paths; honor `--skip-backup-check` admin flag |
| `plugins/autonomous-dev-homelab/src/cli/commands/safety.ts` | Create | `homelab safety check <action-id>` |
| `plugins/autonomous-dev-homelab/src/cli/commands/cancel-action.ts` | Create | `homelab cancel-action <id>` |
| `plugins/autonomous-dev-homelab/src/cli/commands/migrations.ts` | Create | `homelab migrations status [--id <id>]` |
| `plugins/autonomous-dev-homelab/src/cli/index.ts` | Modify | Register the three new subcommands |

## Implementation Details

### Migration Types (TDD §10)

```ts
// plugins/autonomous-dev-homelab/src/migration/types.ts

export type MigrationPhaseName =
  | 'identify-resources'
  | 'plan-target'
  | 'dry-run'
  | 'approval-delay'
  | 'execute';

export interface MigrationPhase {
  name: MigrationPhaseName;
  status: 'pending' | 'in-progress' | 'complete' | 'failed' | 'cancelled';
  started_at?: string;            // ISO 8601
  completed_at?: string;
  output?: unknown;               // Phase-specific (resource list, dry-run report, ...)
  error?: { message: string; code?: string };
}

export interface Migration {
  migration_id: string;                                   // ULID
  source_platform: string;                                // e.g., "portainer"
  target_platform: string;                                // e.g., "k3s"
  classification: 'architectural';                        // ENFORCED: only valid value
  description: string;
  initiated_by: string;                                   // operator id
  initiated_at: string;                                   // ISO 8601
  approval_delay_seconds: number;                         // default 86_400 (24h)
  requires_typed_confirm: true;                           // ENFORCED: only valid value
  phases: MigrationPhase[];                               // ordered; same order as MigrationPhaseName
}

export interface MigrationState extends Migration {
  current_phase_index: number;                            // 0..4
  overall_status: 'in-flight' | 'complete' | 'cancelled' | 'failed';
}
```

### Migration JSON Schema

```json
// plugins/autonomous-dev-homelab/schemas/migration-v1.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev/homelab/schemas/migration-v1.json",
  "type": "object",
  "required": [
    "migration_id", "source_platform", "target_platform",
    "classification", "description", "initiated_by", "initiated_at",
    "approval_delay_seconds", "requires_typed_confirm", "phases"
  ],
  "additionalProperties": false,
  "properties": {
    "migration_id":            { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "source_platform":         { "type": "string", "minLength": 1 },
    "target_platform":         { "type": "string", "minLength": 1 },
    "classification":          { "type": "string", "const": "architectural" },
    "description":             { "type": "string", "minLength": 1 },
    "initiated_by":            { "type": "string", "minLength": 1 },
    "initiated_at":            { "type": "string", "format": "date-time" },
    "approval_delay_seconds":  { "type": "integer", "minimum": 3600 },
    "requires_typed_confirm":  { "type": "boolean", "const": true },
    "phases": {
      "type": "array",
      "minItems": 5,
      "maxItems": 5,
      "items": { "$ref": "#/$defs/phase" }
    }
  },
  "$defs": {
    "phase": {
      "type": "object",
      "required": ["name", "status"],
      "properties": {
        "name": { "type": "string", "enum": ["identify-resources", "plan-target", "dry-run", "approval-delay", "execute"] },
        "status": { "type": "string", "enum": ["pending", "in-progress", "complete", "failed", "cancelled"] },
        "started_at":   { "type": "string", "format": "date-time" },
        "completed_at": { "type": "string", "format": "date-time" },
        "output":       {},
        "error": {
          "type": "object",
          "properties": { "message": { "type": "string" }, "code": { "type": "string" } },
          "required": ["message"]
        }
      }
    }
  }
}
```

### MigrationOrchestrator

```ts
// plugins/autonomous-dev-homelab/src/migration/orchestrator.ts
import type { Migration, MigrationState, MigrationPhaseName } from './types';
import { saveMigrationState, loadMigrationState, listInFlightMigrations } from './state-store';
import { scheduleDelayedAction, cancelDelayedAction } from '../safety/delay';
import { typedConfirmModal } from '../safety/typed-confirm';
import { verifyBackup } from '../backup/orchestrator';
import { ApprovalDeniedError } from '../safety/errors';

export interface PhaseHandlers {
  identifyResources: (m: MigrationState) => Promise<unknown>;
  planTarget:        (m: MigrationState) => Promise<unknown>;
  dryRun:            (m: MigrationState) => Promise<string>;   // dry-run report text
  execute:           (m: MigrationState) => Promise<unknown>;
}

export class MigrationOrchestrator {
  constructor(private handlers: PhaseHandlers) {}

  async start(plan: Migration): Promise<MigrationState> {
    const state: MigrationState = { ...plan, current_phase_index: 0, overall_status: 'in-flight' };
    await saveMigrationState(state);
    return this.run(state);
  }

  /** Resumes a previously-saved migration; called on daemon startup for in-flight migrations. */
  async resume(migrationId: string): Promise<MigrationState> {
    const state = await loadMigrationState(migrationId);
    if (state.overall_status !== 'in-flight') return state;
    return this.run(state);
  }

  private async run(state: MigrationState): Promise<MigrationState> {
    while (state.overall_status === 'in-flight') {
      const phase = state.phases[state.current_phase_index];
      try {
        await this.runPhase(state, phase.name);
      } catch (err: any) {
        phase.status = 'failed';
        phase.error = { message: err?.message ?? 'unknown', code: err?.code };
        state.overall_status = 'failed';
        await saveMigrationState(state);
        throw err;
      }
    }
    return state;
  }

  private async runPhase(state: MigrationState, phaseName: MigrationPhaseName): Promise<void> {
    const phase = state.phases[state.current_phase_index];
    phase.status = 'in-progress';
    phase.started_at = new Date().toISOString();
    await saveMigrationState(state);

    switch (phaseName) {
      case 'identify-resources':
        phase.output = await this.handlers.identifyResources(state); break;
      case 'plan-target':
        phase.output = await this.handlers.planTarget(state); break;
      case 'dry-run':
        phase.output = await this.handlers.dryRun(state); break;
      case 'approval-delay': {
        // Verify backup BEFORE the delay (so ops have time to take one if missing).
        await verifyBackup({ platform: state.source_platform, target: state.source_platform });
        await scheduleDelayedAction({
          actionId: state.migration_id,
          delayMs: state.approval_delay_seconds * 1000,
          dryRunReport: state.phases[2].output as string,
        });
        const ok = await typedConfirmModal({
          message: `Migration ${state.migration_id}: ${state.source_platform} -> ${state.target_platform}\n${state.phases[2].output}`,
          ttl_seconds: 60,
        });
        if (!ok) throw new ApprovalDeniedError(state.migration_id, 'typed-CONFIRM rejected after 24h delay');
        break;
      }
      case 'execute':
        phase.output = await this.handlers.execute(state);
        state.overall_status = 'complete';
        break;
    }

    phase.status = 'complete';
    phase.completed_at = new Date().toISOString();
    state.current_phase_index += 1;
    await saveMigrationState(state);
  }

  async cancel(migrationId: string): Promise<void> {
    const state = await loadMigrationState(migrationId);
    if (state.overall_status !== 'in-flight') return;
    // If we're sitting in approval-delay, cancel that scheduled action too.
    await cancelDelayedAction(migrationId).catch(() => {});
    state.overall_status = 'cancelled';
    state.phases[state.current_phase_index].status = 'cancelled';
    await saveMigrationState(state);
  }

  async listInFlight(): Promise<MigrationState[]> { return listInFlightMigrations(); }
}
```

### Migration State Store

```ts
// plugins/autonomous-dev-homelab/src/migration/state-store.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { signPayload, verifyPayload } from '../safety/hmac';
import type { MigrationState } from './types';

function migrationDir(): string {
  return path.join(process.env.HOMELAB_DATA_DIR ?? process.env.CLAUDE_PLUGIN_DATA ?? '.homelab-data', 'migrations');
}
function migrationPath(id: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error(`Invalid migration id: ${id}`);
  return path.join(migrationDir(), `${id}.json`);
}

export async function saveMigrationState(state: MigrationState): Promise<void> {
  await fs.mkdir(migrationDir(), { recursive: true });
  const signed = signPayload(state);
  await fs.writeFile(migrationPath(state.migration_id), JSON.stringify(signed, null, 2), { mode: 0o600 });
}

export async function loadMigrationState(id: string): Promise<MigrationState> {
  const raw = JSON.parse(await fs.readFile(migrationPath(id), 'utf8'));
  if (!verifyPayload(raw)) throw new Error(`Tampered migration state: ${id}`);
  return raw.payload as MigrationState;
}

export async function listInFlightMigrations(): Promise<MigrationState[]> {
  const dir = migrationDir();
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  const out: MigrationState[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    if (!verifyPayload(raw)) throw new Error(`Tampered migration state: ${f}`);
    if ((raw.payload as MigrationState).overall_status === 'in-flight') out.push(raw.payload);
  }
  return out;
}
```

### Backup Verification

```ts
// plugins/autonomous-dev-homelab/src/backup/types.ts
export interface BackupManifestEntry {
  platform: string;
  backup_type: string;          // 'pve-backup' | 'zfs-snapshot' | 'docker-image' | ...
  taken_at: string;             // ISO 8601
  location: string;             // local path or remote URL
  size_bytes: number;
  hmac: string;                 // HMAC-SHA256 over canonical payload (sans hmac field)
}

export interface FreshnessRule { platform: string; max_age_seconds: number; }
export interface BackupVerificationResult { ok: true; entry: BackupManifestEntry; }
```

```ts
// plugins/autonomous-dev-homelab/src/backup/freshness-rules.ts
export const DEFAULT_FRESHNESS: Record<string, number> = {
  proxmox: 86_400,        // 24h
  truenas: 86_400,        // 24h (zfs)
  freenas: 86_400,
  docker: 7 * 86_400,     // 7d (image rebuilds tolerated)
  kubernetes: 86_400,
  unraid: 86_400,
  unifi: 7 * 86_400,
};
```

```ts
// plugins/autonomous-dev-homelab/src/backup/orchestrator.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { verifyPayload } from '../safety/hmac';
import { BackupRequiredError } from '../safety/errors';
import { DEFAULT_FRESHNESS } from './freshness-rules';
import type { BackupManifestEntry, BackupVerificationResult } from './types';

function manifestPath(): string {
  return path.join(process.env.HOMELAB_DATA_DIR ?? process.env.CLAUDE_PLUGIN_DATA ?? '.homelab-data', 'backup-manifest.json');
}

export interface VerifyInput { platform: string; target: string; freshnessOverrides?: Record<string, number>; }

/**
 * Reads <homelab-data>/backup-manifest.json. Each entry is HMAC-signed.
 * Returns the freshest entry for the given platform IFF it satisfies the freshness rule.
 * Throws BackupRequiredError if no entry found, all entries are stale, or HMAC fails.
 */
export async function verifyBackup(input: VerifyInput): Promise<BackupVerificationResult> {
  const raw = JSON.parse(await fs.readFile(manifestPath(), 'utf8').catch(() => '{"entries":[]}'));
  if (!Array.isArray(raw.entries)) throw new BackupRequiredError(input.target, input.platform);
  const candidates: BackupManifestEntry[] = [];
  for (const e of raw.entries) {
    if (!verifyPayload({ payload: { ...e, hmac: undefined }, hmac: e.hmac })) {
      throw new Error(`Tampered backup-manifest entry for platform=${e.platform}`);
    }
    if (e.platform === input.platform) candidates.push(e);
  }
  if (candidates.length === 0) throw new BackupRequiredError(input.target, input.platform);
  const freshest = candidates.sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at))[0];
  const maxAge = input.freshnessOverrides?.[input.platform] ?? DEFAULT_FRESHNESS[input.platform] ?? 86_400;
  const ageSeconds = (Date.now() - Date.parse(freshest.taken_at)) / 1000;
  if (ageSeconds > maxAge) throw new BackupRequiredError(input.target, `${input.platform} (stale: ${Math.floor(ageSeconds/3600)}h old, limit ${Math.floor(maxAge/3600)}h)`);
  return { ok: true, entry: freshest };
}
```

### Gate Wiring (Task 10 — modify `gate.ts` from SPEC-002-2-01)

```ts
// In gate.ts — modify requestDataAffectingApproval and requestArchitecturalApproval
// Add at the top of each, BEFORE the typedConfirmModal call:

const skipBackupCheck = ctx.flags?.skipBackupCheck === true;
if (skipBackupCheck) {
  if (!ctx.isAdmin()) throw new ApprovalDeniedError(action.id, '--skip-backup-check requires admin role');
  await ctx.audit({ type: 'gate.bypass', action_id: action.id, reason: 'admin used --skip-backup-check', occurred_at: new Date().toISOString() });
} else {
  await verifyBackup({ platform: action.target.platform, target: action.target.resource });
  // verifyBackup throws BackupRequiredError on miss/stale/tamper -- propagated as-is.
}
```

`GateContext` type (from SPEC-002-2-01) gains an optional `flags?: { skipBackupCheck?: boolean }`.

### CLI Commands

```ts
// plugins/autonomous-dev-homelab/src/cli/commands/safety.ts
// Usage: homelab safety check <action-id> [--json]
import { FLOOR } from '../../safety/destructiveness';
import { loadAction } from '../action-store';   // existing helper from PLAN-002-1

export async function safetyCheck(actionId: string, opts: { json?: boolean }): Promise<number> {
  const action = await loadAction(actionId);
  const floor = FLOOR[action.destructiveness];
  const requires: string[] = [];
  if (action.destructiveness === 'data-affecting') requires.push('typed-CONFIRM', 'backup verification');
  if (action.destructiveness === 'architectural')  requires.push('dry-run', '24h delay', 'typed-CONFIRM', 'backup verification');
  const out = { action_id: actionId, destructiveness: action.destructiveness, floor, required_approvals: requires };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else console.log(`Action ${actionId}\n  destructiveness: ${out.destructiveness}\n  floor: ${out.floor}\n  required: ${requires.join(', ') || 'none'}`);
  return 0;
}
```

```ts
// plugins/autonomous-dev-homelab/src/cli/commands/cancel-action.ts
// Usage: homelab cancel-action <id> [--json]
import { cancelDelayedAction } from '../../safety/delay';
import { writeAuditEntry } from '../../audit/writer';   // PLAN-001-3

export async function cancelAction(id: string, opts: { json?: boolean }): Promise<number> {
  await cancelDelayedAction(id);
  await writeAuditEntry({ type: 'action.cancelled', action_id: id, occurred_at: new Date().toISOString() });
  if (opts.json) console.log(JSON.stringify({ action_id: id, status: 'cancelled' }));
  else console.log(`Action ${id} cancelled.`);
  return 0;
}
```

```ts
// plugins/autonomous-dev-homelab/src/cli/commands/migrations.ts
// Usage: homelab migrations status [--id <id>] [--json]
import { listInFlightMigrations, loadMigrationState } from '../../migration/state-store';

export async function migrationsStatus(opts: { id?: string; json?: boolean }): Promise<number> {
  const migrations = opts.id ? [await loadMigrationState(opts.id)] : await listInFlightMigrations();
  const view = migrations.map((m) => {
    const phase = m.phases[m.current_phase_index];
    let remainingSeconds: number | null = null;
    if (phase.name === 'approval-delay' && phase.started_at) {
      const elapsed = (Date.now() - Date.parse(phase.started_at)) / 1000;
      remainingSeconds = Math.max(0, m.approval_delay_seconds - elapsed);
    }
    return { migration_id: m.migration_id, source: m.source_platform, target: m.target_platform, current_phase: phase.name, status: phase.status, remaining_seconds: remainingSeconds, overall: m.overall_status };
  });
  if (opts.json) console.log(JSON.stringify(view, null, 2));
  else for (const v of view) console.log(`${v.migration_id}: ${v.source}->${v.target} | phase=${v.current_phase}(${v.status}) | overall=${v.overall}${v.remaining_seconds != null ? ` | remaining=${Math.floor(v.remaining_seconds/60)}m` : ''}`);
  return 0;
}
```

## Acceptance Criteria

### Migration Schema & Types
- [ ] `Migration['classification']` is the literal type `'architectural'` (TS prevents other values).
- [ ] `Migration['requires_typed_confirm']` is the literal type `true`.
- [ ] JSON schema validates the TDD §10 example payload (provide as fixture in tests).
- [ ] Schema rejects payloads missing any required field (test each one).
- [ ] Schema rejects `classification: 'reversible'` (and any value other than `'architectural'`).
- [ ] Schema rejects `requires_typed_confirm: false`.
- [ ] Schema rejects `phases` arrays with fewer or more than 5 items.
- [ ] Schema rejects `approval_delay_seconds < 3600` (1h minimum).

### MigrationOrchestrator — Phase Iteration
- [ ] `start(plan)` runs phases in order: identify-resources → plan-target → dry-run → approval-delay → execute.
- [ ] State file persisted after every phase status change (test inspects file content after each).
- [ ] After each phase completes, `current_phase_index` increments by 1 and the previous phase's `status` is `'complete'` with `completed_at` set.
- [ ] If any phase handler throws, that phase's `status` becomes `'failed'`, `error.message` is captured, `overall_status` becomes `'failed'`, state is persisted, and `start` rethrows.
- [ ] Approval-delay phase calls `verifyBackup` BEFORE `scheduleDelayedAction` (verified by call order spy).
- [ ] Approval-delay phase calls `scheduleDelayedAction` with `delayMs === approval_delay_seconds * 1000`.
- [ ] Approval-delay phase calls `typedConfirmModal` AFTER the delay completes; on `false`, throws `ApprovalDeniedError` with code `APPROVAL_DENIED`.
- [ ] `execute` phase only runs after typed-CONFIRM returns `true`.

### MigrationOrchestrator — Restart & Cancel
- [ ] `resume(id)` for a state with `overall_status === 'in-flight'` continues from `current_phase_index`.
- [ ] `resume(id)` for a state with `overall_status === 'complete' | 'cancelled' | 'failed'` returns immediately without re-running.
- [ ] `cancel(id)` marks `overall_status = 'cancelled'`, marks current phase `status = 'cancelled'`, persists, and calls `cancelDelayedAction(id)` (no-op if not in delay phase).
- [ ] `listInFlight()` returns only migrations with `overall_status === 'in-flight'`.

### Backup Verification
- [ ] `verifyBackup({platform: 'proxmox', target: 'node1'})` with no manifest file: throws `BackupRequiredError` (code `BACKUP_REQUIRED`).
- [ ] With manifest containing a fresh `proxmox` entry (taken < 24h ago): returns `{ok: true, entry: <that entry>}`.
- [ ] With manifest containing only stale (> 24h) `proxmox` entries: throws `BackupRequiredError` with a message containing the staleness duration.
- [ ] With manifest containing a tampered entry (HMAC mismatch): throws an error with message containing "Tampered backup-manifest entry" and the platform.
- [ ] Custom freshness override: `verifyBackup({platform: 'docker', target: 'app', freshnessOverrides: {docker: 3600}})` rejects a 2h-old docker entry.
- [ ] Sorts by `taken_at` desc and returns the freshest when multiple entries exist for the same platform.

### Gate Wiring (Task 10)
- [ ] For a `data-affecting` action with no fresh backup: `gateApproval` throws `BackupRequiredError` BEFORE invoking `typedConfirmModal` (verified by mock call order — `verifyBackup` is called, `typedConfirmModal` is NOT).
- [ ] For an `architectural` action with no fresh backup: same behavior; thrown before scheduling the 24h delay.
- [ ] With `ctx.flags.skipBackupCheck = true` AND `ctx.isAdmin() === true`: `verifyBackup` is NOT called, `typedConfirmModal` IS called, and a `gate.bypass` audit event is emitted with reason "admin used --skip-backup-check".
- [ ] With `ctx.flags.skipBackupCheck = true` AND `ctx.isAdmin() === false`: throws `ApprovalDeniedError` with message containing "requires admin role".
- [ ] No regression on `read-only`, `reversible`, `persistent-modifying` paths (no `verifyBackup` call).

### CLI — `safety check`
- [ ] `homelab safety check <id>` prints destructiveness, floor, and required-approvals list.
- [ ] `--json` mode emits a JSON object with keys `action_id`, `destructiveness`, `floor`, `required_approvals`.
- [ ] For `data-affecting`: `required_approvals` includes "typed-CONFIRM" and "backup verification".
- [ ] For `architectural`: `required_approvals` includes "dry-run", "24h delay", "typed-CONFIRM", "backup verification".
- [ ] For `read-only`: `required_approvals` is empty (or "none" in human mode).
- [ ] Exit code 0 on success; non-zero on action-not-found.

### CLI — `cancel-action`
- [ ] `homelab cancel-action <id>` calls `cancelDelayedAction(id)` and writes an audit entry of type `action.cancelled`.
- [ ] `--json` mode emits `{action_id, status: 'cancelled'}`.
- [ ] Exit code 0 even if action did not exist (idempotent).

### CLI — `migrations status`
- [ ] `homelab migrations status` lists all in-flight migrations with one line each: `{id}: {source}->{target} | phase={phase}({status}) | overall=in-flight | remaining={N}m` when in approval-delay.
- [ ] `--id <id>` shows one specific migration (in-flight or terminal).
- [ ] `--json` mode emits an array of migration view objects (keys: `migration_id`, `source`, `target`, `current_phase`, `status`, `remaining_seconds`, `overall`).
- [ ] `remaining_seconds` is `null` for phases other than `approval-delay`.
- [ ] `remaining_seconds` is `0` if the delay window has elapsed but the action has not yet fired.

### Coverage
- [ ] Coverage on `migration/`, `backup/`, and the modified `gate.ts` is ≥ 95%.

## Dependencies

- **SPEC-002-2-01** — provides `gateApproval`, `Action`, `OperatorConfig`, error classes, and `FLOOR`. This spec MODIFIES `gate.ts`.
- **SPEC-002-2-02** — provides `scheduleDelayedAction`, `cancelDelayedAction`, `typedConfirmModal`, `signPayload`/`verifyPayload`. Reused by migration state store and backup orchestrator.
- **PLAN-002-1** — provides `loadAction` (action store) and the existing `homelab` CLI binary for subcommand registration.
- **PLAN-001-3** — provides `writeAuditEntry`.
- **TDD-002 §10, §11** — single source of truth for migration phases and backup orchestration semantics.
- Node `node:fs/promises`, `node:path`, `node:crypto` (transitively via SPEC-002-2-02 helpers).
- A JSON Schema validator (e.g., `ajv`) for the migration schema test fixture.

## Notes

- **Reuse, don't duplicate, the HMAC helpers.** Migration state files and backup manifest entries share `signPayload`/`verifyPayload` from SPEC-002-2-02. Same secret env var. Rotating the secret invalidates everything (pending actions, migration states, backup manifest) — accepted MVP trade-off.
- **`verifyBackup` is called BEFORE the 24h delay starts in the migration orchestrator.** Rationale: if backup is missing, fail immediately so the operator can take one. Failing 24h later is hostile UX.
- **`gateApproval` calls `verifyBackup` AFTER scheduling the delay for non-migration architectural actions** (per the SPEC-002-2-01 sequence). The migration orchestrator chooses earlier verification because of its multi-phase nature; gate's path is for one-shot architectural actions where the dry-run phase already completed.
- **Risk-register hardening note (live verification):** The freshness check here trusts `backup-manifest.json` is up-to-date. The plan's risk register notes a future enhancement: per-platform "live" verification (e.g., `pve-backup status`) configurable as `verify_via: manifest|live`. That enhancement is OUT of scope for this spec; documented as future work.
- **`--skip-backup-check` is documented in the operator README as last-resort.** Audit-logged with operator id; admin-only. The audit event type is `gate.bypass`, distinct from `gate.allowed` for filterability.
- **Migration `approval_delay_seconds` minimum is 3600 (1h).** Per the plan's risk register, urgent architectural actions can shorten the default 24h delay to 1h with admin sign-off. This spec encodes the floor in the JSON schema; the admin-sign-off mechanism for urgent flagging lives in a follow-up plan.
- The CLI commands assume the existing `homelab` binary's argument-parsing conventions (likely `commander` or similar). The exact integration into `cli/index.ts` follows whatever pattern PLAN-002-1 established. If that pattern uses subcommand routers, register all three subcommands there; if it uses a flat command map, append three entries.
- ULID format regex `^[0-9A-HJKMNP-TV-Z]{26}$` is Crockford base32. The action-store and migration-store both validate this server-side to prevent path traversal via crafted ids.
