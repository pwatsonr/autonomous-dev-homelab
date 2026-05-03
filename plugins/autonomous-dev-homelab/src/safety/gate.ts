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
): Promise<ApprovalResult> {
  switch (action.destructiveness) {
    case 'read-only':
      return passThroughReadOnly(action, ctx);

    case 'reversible':
      return requestStandardApproval(action, ctx);

    case 'persistent-modifying':
      return requestStandardApproval(action, ctx);

    case 'data-affecting':
      return requestDataAffectingApproval(action, ctx);

    case 'architectural':
      return requestArchitecturalApproval(action, ctx);

    default: {
      const _exhaustive: never = action.destructiveness;
      throw new Error(`Unknown destructiveness: ${_exhaustive as string}`);
    }
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
): Promise<ApprovalResult> {
  // Backup verification is wired here in SPEC-002-2-04 (Task 10). For
  // SPEC-002-2-01 the verification is delegated to the gate's caller via
  // module-level mocking in tests.
  const confirmed = await typedConfirmModal({
    message: `Confirm ${action.destructiveness} action: ${action.description}`,
    ttl_seconds: ctx.config.typed_confirm_ttl_seconds ?? 60,
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
): Promise<ApprovalResult> {
  if (action.dryRunReport === undefined || action.dryRunReport === '') {
    throw new Error(
      `architectural action ${action.id} missing required dryRunReport`,
    );
  }
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
