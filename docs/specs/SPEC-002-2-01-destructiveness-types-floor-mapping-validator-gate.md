# SPEC-002-2-01: Destructiveness Types, FLOOR Mapping, validateOperatorConfig, and gateApproval

## Metadata
- **Parent Plan**: PLAN-002-2 (Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration)
- **Tasks Covered**: Task 1 (destructiveness types + ladder), Task 2 (validateOperatorConfig), Task 3 (gateApproval skeleton + happy paths)
- **Future Home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-2-01-destructiveness-types-floor-mapping-validator-gate.md`
- **Estimated effort**: 8.5 hours

## Description
Establish the safety-critical foundation of the homelab autofix workflow: the destructiveness ladder (TDD §8), the per-level trust-floor mapping that operators cannot configure below, the config-load-time validator that rejects below-floor configurations, and the action-execution-time `gateApproval` that routes each action through the appropriate approval flow.

This spec covers the **type contract**, the **validator**, and the **gate skeleton with the read-only and reversible paths fully wired**. The `data-affecting` and `architectural` paths in `gateApproval` are wired to call the typed-CONFIRM modal (SPEC-002-2-02) and the 24h delay (SPEC-002-2-02) and backup verifier (SPEC-002-2-04) — those collaborators are imported by name and mocked in this spec's tests. The actual implementations land in their respective specs.

The ladder is the single source of truth for "how dangerous is this action?" Every downstream component (gate, agents, migration orchestrator, deploy backends in PLAN-002-3) consults `FLOOR` and `gateApproval`. Getting these wrong means the autonomous system can perform destructive operations without operator consent. Tests must cover the full 5×4 truth table.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/safety/destructiveness.ts` | Create | `Destructiveness` enum + `TrustLevel` type + `FLOOR` constant |
| `plugins/autonomous-dev-homelab/src/safety/errors.ts` | Create | `ConfigurationError`, `ApprovalDeniedError`, `BackupRequiredError` (declared here; thrown by gate + validator) |
| `plugins/autonomous-dev-homelab/src/safety/validator.ts` | Create | `validateOperatorConfig(config)` — runs at config load, throws `ConfigurationError` |
| `plugins/autonomous-dev-homelab/src/safety/gate.ts` | Create | `gateApproval(action)` — routes by destructiveness; full impl for read-only + reversible; calls collaborators (typed-confirm, delay, backup) for data-affecting + architectural |
| `plugins/autonomous-dev-homelab/src/safety/types.ts` | Create | Shared types: `Action`, `OperatorConfig`, `ApprovalResult`, `GateContext` |
| `plugins/autonomous-dev-homelab/src/safety/index.ts` | Create | Public barrel export |

## Implementation Details

### Destructiveness Enum & FLOOR (TDD §8)

```ts
// plugins/autonomous-dev-homelab/src/safety/destructiveness.ts

/**
 * Destructiveness ladder per TDD-002 §8.
 * Each operation MUST be classified into exactly one of these levels.
 * The classification drives the minimum required trust-level floor.
 */
export type Destructiveness =
  | 'read-only'
  | 'reversible'
  | 'persistent-modifying'
  | 'data-affecting'
  | 'architectural';

/**
 * Trust levels per PRD-009 (autonomous-dev).
 * L3 = full automation; L0 = strict per-action operator approval.
 */
export type TrustLevel = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * FLOOR mapping per TDD-002 §8.
 * Each destructiveness level has a MINIMUM required trust level.
 * Operators MAY configure a level HIGHER than the floor (more friction);
 * they MAY NOT configure a level LOWER (less friction). The validator enforces this.
 */
export const FLOOR: Readonly<Record<Destructiveness, TrustLevel>> = Object.freeze({
  'read-only': 'L3',
  'reversible': 'L1',
  'persistent-modifying': 'L0',
  'data-affecting': 'L0',
  'architectural': 'L0',
});

/** Numeric ordering for floor comparison (higher number = more permissive). */
export const TRUST_RANK: Readonly<Record<TrustLevel, number>> = Object.freeze({
  L0: 0, L1: 1, L2: 2, L3: 3,
});

export function meetsFloor(configured: TrustLevel, required: TrustLevel): boolean {
  return TRUST_RANK[configured] <= TRUST_RANK[required];
}
```

### Shared Types

```ts
// plugins/autonomous-dev-homelab/src/safety/types.ts
import type { Destructiveness, TrustLevel } from './destructiveness';

export interface Action {
  id: string;                              // ULID
  destructiveness: Destructiveness;
  target: { platform: string; resource: string };
  description: string;                     // Human-readable summary for approval prompt
  dryRunReport?: string;                   // Required for architectural; optional otherwise
  requestedBy: string;                     // Agent or operator identifier
  initiatedAt: string;                     // ISO 8601
}

export interface OperatorConfig {
  auto_approval: Record<Destructiveness, TrustLevel>;
  typed_confirm_ttl_seconds?: number;      // default 60
  delay_state_dir?: string;                // default `<homelab-data>/pending-actions/`
  hmac_secret_env?: string;                // env var name; default 'HOMELAB_HMAC_SECRET'
}

export type ApprovalResult =
  | { approved: true; actionId: string; approvedAt: string; approvedBy: string }
  | { approved: false; actionId: string; reason: string };

export interface GateContext {
  config: OperatorConfig;
  isAdmin: () => boolean;                  // injected; reads current operator role
  audit: (event: SafetyAuditEvent) => Promise<void>;  // injected; from PLAN-001-3
}

export interface SafetyAuditEvent {
  type: 'gate.allowed' | 'gate.denied' | 'gate.bypass' | 'config.rejected';
  action_id?: string;
  reason: string;
  occurred_at: string;
}
```

### Errors

```ts
// plugins/autonomous-dev-homelab/src/safety/errors.ts
export class ConfigurationError extends Error {
  readonly code = 'CONFIG_BELOW_FLOOR';
  constructor(public details: { destructiveness: string; configured: string; floor: string }) {
    super(
      `Operator config sets auto_approval.${details.destructiveness}=${details.configured}, ` +
      `but the destructiveness floor requires ${details.floor} or stricter (TDD §8).`
    );
    this.name = 'ConfigurationError';
  }
}

export class ApprovalDeniedError extends Error {
  readonly code = 'APPROVAL_DENIED';
  constructor(public actionId: string, reason: string) {
    super(`Action ${actionId} denied: ${reason}`);
    this.name = 'ApprovalDeniedError';
  }
}

export class BackupRequiredError extends Error {
  readonly code = 'BACKUP_REQUIRED';
  constructor(public actionId: string, public target: string) {
    super(`Action ${actionId} requires a fresh backup of ${target}; none found in manifest.`);
    this.name = 'BackupRequiredError';
  }
}
```

### Validator

```ts
// plugins/autonomous-dev-homelab/src/safety/validator.ts
import { FLOOR, meetsFloor, type Destructiveness } from './destructiveness';
import { ConfigurationError } from './errors';
import type { OperatorConfig } from './types';

/**
 * MUST be called at config-load time. Throws ConfigurationError if any
 * `auto_approval.<level>` value is below the FLOOR for that level.
 */
export function validateOperatorConfig(config: OperatorConfig): void {
  const levels = Object.keys(FLOOR) as Destructiveness[];
  for (const level of levels) {
    const configured = config.auto_approval?.[level];
    if (!configured) {
      throw new ConfigurationError({ destructiveness: level, configured: 'undefined', floor: FLOOR[level] });
    }
    if (!meetsFloor(configured, FLOOR[level])) {
      throw new ConfigurationError({ destructiveness: level, configured, floor: FLOOR[level] });
    }
  }
}
```

### gateApproval (skeleton + read-only/reversible fully wired)

```ts
// plugins/autonomous-dev-homelab/src/safety/gate.ts
import type { Action, ApprovalResult, GateContext } from './types';
import { ApprovalDeniedError } from './errors';

// Collaborators implemented in sibling specs:
import { typedConfirmModal } from './typed-confirm';            // SPEC-002-2-02
import { scheduleDelayedAction } from './delay';                 // SPEC-002-2-02
import { verifyBackup } from '../backup/orchestrator';           // SPEC-002-2-04
import { runDryRun } from './dry-run';                           // SPEC-002-2-04 stub or this spec

export async function gateApproval(action: Action, ctx: GateContext): Promise<ApprovalResult> {
  switch (action.destructiveness) {
    case 'read-only':
      // Pass-through. No approval needed; audit and return.
      await ctx.audit({ type: 'gate.allowed', action_id: action.id, reason: 'read-only pass-through', occurred_at: new Date().toISOString() });
      return { approved: true, actionId: action.id, approvedAt: new Date().toISOString(), approvedBy: 'system' };

    case 'reversible':
      // L1: standard approval flow (single yes/no prompt; uses existing approval-gate UI).
      return requestStandardApproval(action, ctx);

    case 'persistent-modifying':
      // L0: standard approval flow (no typed-CONFIRM, no delay, no backup check).
      return requestStandardApproval(action, ctx);

    case 'data-affecting':
      // L0 + typed-CONFIRM + backup verification (backup wiring lands in SPEC-002-2-04).
      // For SPEC-002-2-01, the backup call is delegated to verifyBackup (mocked in tests here).
      return requestDataAffectingApproval(action, ctx);

    case 'architectural':
      // L0 + dry-run + 24h delay + typed-CONFIRM + backup.
      return requestArchitecturalApproval(action, ctx);

    default: {
      const _exhaustive: never = action.destructiveness;
      throw new Error(`Unknown destructiveness: ${_exhaustive}`);
    }
  }
}

async function requestStandardApproval(action: Action, ctx: GateContext): Promise<ApprovalResult> {
  // Stub for tests: in prod, calls into the approval-gate UI from PLAN-002-1.
  // Returns { approved, actionId, approvedAt, approvedBy } or throws ApprovalDeniedError.
  // TODO(PLAN-002-1): wire to real approval-gate IPC.
  throw new Error('NOT_IMPLEMENTED: requestStandardApproval — wired in PLAN-002-1 integration');
}

async function requestDataAffectingApproval(action: Action, ctx: GateContext): Promise<ApprovalResult> {
  // Backup verification wired in SPEC-002-2-04 (Task 10). Skeleton only here.
  const confirmed = await typedConfirmModal({
    message: `Confirm ${action.destructiveness} action: ${action.description}`,
    ttl_seconds: ctx.config.typed_confirm_ttl_seconds ?? 60,
  });
  if (!confirmed) {
    await ctx.audit({ type: 'gate.denied', action_id: action.id, reason: 'typed-CONFIRM rejected or timed out', occurred_at: new Date().toISOString() });
    throw new ApprovalDeniedError(action.id, 'typed-CONFIRM rejected');
  }
  await ctx.audit({ type: 'gate.allowed', action_id: action.id, reason: 'data-affecting approved via typed-CONFIRM', occurred_at: new Date().toISOString() });
  return { approved: true, actionId: action.id, approvedAt: new Date().toISOString(), approvedBy: 'operator' };
}

async function requestArchitecturalApproval(action: Action, ctx: GateContext): Promise<ApprovalResult> {
  // Architectural always requires: dryRunReport (operator MUST review during the 24h window) + delay + CONFIRM.
  if (!action.dryRunReport) {
    throw new Error(`architectural action ${action.id} missing required dryRunReport`);
  }
  // Schedule the action for 24h later. Returns when the delay completes (or throws on cancellation).
  await scheduleDelayedAction({ actionId: action.id, delayMs: 24 * 60 * 60 * 1000, dryRunReport: action.dryRunReport });
  // After the delay, the typed-CONFIRM is required.
  const confirmed = await typedConfirmModal({
    message: `Confirm architectural action after 24h delay: ${action.description}`,
    ttl_seconds: ctx.config.typed_confirm_ttl_seconds ?? 60,
  });
  if (!confirmed) {
    await ctx.audit({ type: 'gate.denied', action_id: action.id, reason: 'architectural typed-CONFIRM rejected', occurred_at: new Date().toISOString() });
    throw new ApprovalDeniedError(action.id, 'typed-CONFIRM rejected after delay');
  }
  await ctx.audit({ type: 'gate.allowed', action_id: action.id, reason: 'architectural approved after 24h delay + typed-CONFIRM', occurred_at: new Date().toISOString() });
  return { approved: true, actionId: action.id, approvedAt: new Date().toISOString(), approvedBy: 'operator' };
}
```

### Public Barrel

```ts
// plugins/autonomous-dev-homelab/src/safety/index.ts
export * from './destructiveness';
export * from './types';
export * from './errors';
export { validateOperatorConfig } from './validator';
export { gateApproval } from './gate';
```

## Acceptance Criteria

- [ ] `Destructiveness` is a string-literal union of exactly the 5 TDD §8 levels (`read-only`, `reversible`, `persistent-modifying`, `data-affecting`, `architectural`).
- [ ] `FLOOR` is a frozen object; runtime mutation throws in strict mode.
- [ ] `FLOOR['read-only'] === 'L3'`, `FLOOR['reversible'] === 'L1'`, `FLOOR['persistent-modifying'] === 'L0'`, `FLOOR['data-affecting'] === 'L0'`, `FLOOR['architectural'] === 'L0'`.
- [ ] `meetsFloor('L3', 'L0')` returns `false` (L3 is too permissive); `meetsFloor('L0', 'L0')` returns `true`; `meetsFloor('L0', 'L3')` returns `true`.
- [ ] `validateOperatorConfig({ auto_approval: { 'data-affecting': 'L1', ... } })` throws `ConfigurationError` with code `CONFIG_BELOW_FLOOR` and details.destructiveness === 'data-affecting'.
- [ ] `validateOperatorConfig({ auto_approval: { 'read-only': 'L3', 'reversible': 'L1', 'persistent-modifying': 'L0', 'data-affecting': 'L0', 'architectural': 'L0' } })` succeeds (no throw).
- [ ] `validateOperatorConfig({ auto_approval: {} })` throws `ConfigurationError` for the first missing level.
- [ ] All 5×4 = 20 (destructiveness × trust-level) combinations have unit tests; the 12 below-floor combinations throw and the 8 at-or-above-floor combinations pass.
- [ ] `gateApproval` for `read-only`: returns `{ approved: true, approvedBy: 'system' }` without invoking any collaborator (typed-confirm, delay, backup all NOT called — verified by mock spy).
- [ ] `gateApproval` for `architectural` with no `dryRunReport`: throws an error containing the action id and "missing required dryRunReport".
- [ ] `gateApproval` for `data-affecting`: invokes `typedConfirmModal` exactly once; on `false` return, throws `ApprovalDeniedError` with code `APPROVAL_DENIED`; on `true` return, resolves with `approved: true, approvedBy: 'operator'`.
- [ ] `gateApproval` for `architectural`: invokes `scheduleDelayedAction` with `delayMs === 86_400_000` (exactly 24h in ms), then `typedConfirmModal`. Order verified by call sequence.
- [ ] All audit events (`gate.allowed`, `gate.denied`) are emitted with the correct `action_id` and a non-empty `reason`. Verified by mock audit spy.
- [ ] TypeScript strict mode compiles without errors. The exhaustive `switch` on `Destructiveness` triggers a compile error if a new level is added without a case.
- [ ] Public barrel re-exports `Destructiveness`, `FLOOR`, `validateOperatorConfig`, `gateApproval`, and all error classes.

## Dependencies

- **TDD-002 §8** (destructiveness ladder + FLOOR table) — single source of truth for level mapping.
- **PRD-009 (autonomous-dev)** — defines L0–L3 trust levels.
- **SPEC-002-2-02** (provides `typedConfirmModal`, `scheduleDelayedAction`) — collaborators imported here, mocked in tests.
- **SPEC-002-2-04** (provides `verifyBackup`) — wired into `gateApproval` for data-affecting/architectural by Task 10 in that spec.
- **PLAN-002-1** (approval-gate UI) — `requestStandardApproval` placeholder; real wiring lands when the IPC contract is finalized.
- **PLAN-001-3** (audit log writer) — `ctx.audit` injected; this spec only declares the event shape.

## Notes

- **No collaborator implementations live in this spec.** The collaborators (typed-confirm, delay, backup) are imported by name and stubbed in tests via mock spies. The actual implementations are in SPEC-002-2-02 and SPEC-002-2-04. This split lets the gate's routing logic be reviewed and tested independently of the collaborator complexity.
- The `requestStandardApproval` function is intentionally `NOT_IMPLEMENTED` here — the integration with PLAN-002-1's approval UI happens once that contract is stable. Tests for this spec mock it.
- `FLOOR` is `Object.freeze`-d and typed as `Readonly<Record<...>>`. Any future change to the floor mapping is a TDD §8 change and requires a separate plan + spec — not a config tweak.
- `meetsFloor` uses numeric ordering where L0 < L1 < L2 < L3. "Configured meets floor" means `configured` is at or stricter than `floor` (i.e., `configured`'s rank is ≤ `floor`'s rank). Read the JSDoc carefully — it's easy to invert.
- The validator runs ONCE at daemon startup. There's no live re-validation; restarting the daemon picks up new config. This is intentional — operators should not be able to lower their floor mid-session by editing config.
- All errors carry a `code` property for machine-readable handling downstream (CLI exit codes, audit log filtering).
