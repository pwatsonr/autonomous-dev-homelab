/**
 * `gateApproval` per SPEC-002-2-01.
 *
 * Routes each action through the appropriate approval flow per its
 * destructiveness classification. The 5-way switch is exhaustive at
 * compile time: adding a new `Destructiveness` value triggers a TS
 * compile error in the `default` branch (`never` exhaustiveness check).
 *
 * Collaborators (`typedConfirmModal`, `scheduleDelayedAction`,
 * `verifyBackup`) are imported by name. Their real implementations land
 * in SPEC-002-2-02 (typed-confirm, delay) and SPEC-002-2-04 (backup
 * orchestrator). Tests in this spec mock them via Jest module mocks.
 *
 * `requestStandardApproval` is intentionally `NOT_IMPLEMENTED`; it wires
 * to PLAN-002-1's approval-gate UI when that contract stabilizes.
 */

import type { Action, ApprovalResult, GateContext } from './types.js';
import { ApprovalDeniedError } from './errors.js';
import { typedConfirmModal } from './typed-confirm.js';
import { scheduleDelayedAction } from './delay.js';
import { verifyBackup } from '../backup/orchestrator.js';
import { emitGateLatency } from '../metrics/emitters.js';
import { recordMissingAdminBypass } from './validator.js';
import type { ActionType } from '../metrics/types.js';

/**
 * Optional metric-emit hook for the gate. SPEC-002-3-03 §"Wiring into
 * existing flows". When `actionType` is supplied (the action's
 * autonomous-dev request_type), the gate emits a
 * `homelab_gate_latency_seconds` measurement on completion. Default is
 * undefined → no metric emission (preserves baseline test behavior).
 */
export interface GateMetricsHook {
  actionType: ActionType;
  /** Operator id used for `missing-admin` bypass-attempt metric. */
  operatorId: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Routes `action` through the appropriate approval flow. Returns an
 * `ApprovalResult` on success; throws `ApprovalDeniedError` on operator
 * rejection, `BackupRequiredError` (from `verifyBackup`) on missing
 * backups, or generic `Error` on misconfiguration (e.g. architectural
 * action missing `dryRunReport`).
 */
export async function gateApproval(
  action: Action,
  ctx: GateContext,
  metrics?: GateMetricsHook,
): Promise<ApprovalResult> {
  const startedAt = Date.now();
  const emit = (): void => {
    if (metrics === undefined) return;
    emitGateLatency(metrics.actionType, action.destructiveness, Date.now() - startedAt);
  };
  try {
    switch (action.destructiveness) {
      case 'read-only':
        return await passThroughReadOnly(action, ctx);

      case 'reversible':
        return await requestStandardApproval(action, ctx);

      case 'persistent-modifying':
        return await requestStandardApproval(action, ctx);

      case 'data-affecting':
        return await requestDataAffectingApproval(action, ctx, metrics);

      case 'architectural':
        return await requestArchitecturalApproval(action, ctx, metrics);

      default: {
        const _exhaustive: never = action.destructiveness;
        throw new Error(`Unknown destructiveness: ${_exhaustive as string}`);
      }
    }
  } finally {
    emit();
  }
}

async function passThroughReadOnly(
  action: Action,
  ctx: GateContext,
): Promise<ApprovalResult> {
  const ts = new Date().toISOString();
  await ctx.audit({
    type: 'gate.allowed',
    action_id: action.id,
    reason: 'read-only pass-through',
    occurred_at: ts,
  });
  return { approved: true, actionId: action.id, approvedAt: ts, approvedBy: 'system' };
}

/**
 * Reversible + persistent-modifying flow placeholder. Wires to PLAN-002-1
 * approval-gate UI once finalized. Tests mock this function via Jest.
 */
async function requestStandardApproval(
  _action: Action,
  _ctx: GateContext,
): Promise<ApprovalResult> {
  throw new Error(
    'NOT_IMPLEMENTED: requestStandardApproval — wired in PLAN-002-1 integration',
  );
}

async function requestDataAffectingApproval(
  action: Action,
  ctx: GateContext,
  metrics?: GateMetricsHook,
): Promise<ApprovalResult> {
  // SPEC-002-2-04 Task 10: backup verification BEFORE typed-CONFIRM.
  // `--skip-backup-check` is admin-only; logged as `gate.bypass`.
  await runBackupCheck(action, ctx, metrics);
  const confirmed = await typedConfirmModal({
    message: `Confirm ${action.destructiveness} action: ${action.description}`,
    ttl_seconds: ctx.config.typed_confirm_ttl_seconds ?? 60,
    ...(metrics !== undefined ? { operatorId: metrics.operatorId } : {}),
  });
  const ts = new Date().toISOString();
  if (!confirmed) {
    await ctx.audit({
      type: 'gate.denied',
      action_id: action.id,
      reason: 'typed-CONFIRM rejected or timed out',
      occurred_at: ts,
    });
    throw new ApprovalDeniedError(action.id, 'typed-CONFIRM rejected');
  }
  await ctx.audit({
    type: 'gate.allowed',
    action_id: action.id,
    reason: 'data-affecting approved via typed-CONFIRM',
    occurred_at: ts,
  });
  return { approved: true, actionId: action.id, approvedAt: ts, approvedBy: 'operator' };
}

async function requestArchitecturalApproval(
  action: Action,
  ctx: GateContext,
  metrics?: GateMetricsHook,
): Promise<ApprovalResult> {
  if (action.dryRunReport === undefined || action.dryRunReport === '') {
    throw new Error(
      `architectural action ${action.id} missing required dryRunReport`,
    );
  }
  // SPEC-002-2-04 Task 10: backup verification BEFORE the 24h delay so
  // missing backups fail immediately, not 24h later.
  await runBackupCheck(action, ctx, metrics);
  // Schedule the action for 24h. Resolves when the delay completes; rejects
  // on cancellation.
  await scheduleDelayedAction({
    actionId: action.id,
    delayMs: ONE_DAY_MS,
    dryRunReport: action.dryRunReport,
  });
  const confirmed = await typedConfirmModal({
    message: `Confirm architectural action after 24h delay: ${action.description}`,
    ttl_seconds: ctx.config.typed_confirm_ttl_seconds ?? 60,
    ...(metrics !== undefined ? { operatorId: metrics.operatorId } : {}),
  });
  const ts = new Date().toISOString();
  if (!confirmed) {
    await ctx.audit({
      type: 'gate.denied',
      action_id: action.id,
      reason: 'architectural typed-CONFIRM rejected',
      occurred_at: ts,
    });
    throw new ApprovalDeniedError(action.id, 'typed-CONFIRM rejected after delay');
  }
  await ctx.audit({
    type: 'gate.allowed',
    action_id: action.id,
    reason: 'architectural approved after 24h delay + typed-CONFIRM',
    occurred_at: ts,
  });
  return { approved: true, actionId: action.id, approvedAt: ts, approvedBy: 'operator' };
}

/**
 * Verifies a fresh backup exists for the action's target, OR honors the
 * admin-only `skipBackupCheck` flag. Non-admins requesting the bypass are
 * rejected with `ApprovalDeniedError`. Audit-logs `gate.bypass` on success.
 *
 * Throws `BackupRequiredError` (propagated from `verifyBackup`) when the
 * manifest is missing/stale/tampered.
 */
async function runBackupCheck(
  action: Action,
  ctx: GateContext,
  metrics?: GateMetricsHook,
): Promise<void> {
  const skip = ctx.flags?.skipBackupCheck === true;
  if (skip) {
    if (!ctx.isAdmin()) {
      // SPEC-002-3-03: non-admin attempting the admin-only bypass path
      // counts as a `missing-admin` bypass attempt.
      if (metrics !== undefined) {
        recordMissingAdminBypass(metrics.operatorId);
      }
      throw new ApprovalDeniedError(action.id, '--skip-backup-check requires admin role');
    }
    await ctx.audit({
      type: 'gate.bypass',
      action_id: action.id,
      reason: 'admin used --skip-backup-check',
      occurred_at: new Date().toISOString(),
    });
    return;
  }
  await verifyBackup({ platform: action.target.platform, target: action.target.resource });
}
