/**
 * `gateApproval` paths. SPEC-002-2-05.
 *
 * Strategy: stub the three collaborators (`typedConfirmModal`,
 * `scheduleDelayedAction`, `verifyBackup`) via Jest module mocks. We
 * exercise:
 *   - read-only pass-through (no collaborator calls);
 *   - reversible / persistent-modifying NOT_IMPLEMENTED standard flow;
 *   - data-affecting happy path + denial;
 *   - architectural happy path + missing dryRunReport + denial;
 *   - backup-required failure (BackupRequiredError);
 *   - admin bypass (audit emitted) + non-admin bypass rejection.
 */

import { gateApproval } from '../../src/safety/gate';
import {
  ApprovalDeniedError,
  BackupRequiredError,
} from '../../src/safety/errors';
import type { Action, GateContext, OperatorConfig, SafetyAuditEvent } from '../../src/safety/types';

jest.mock('../../src/safety/typed-confirm', () => ({
  typedConfirmModal: jest.fn(),
}));
jest.mock('../../src/safety/delay', () => ({
  scheduleDelayedAction: jest.fn(),
  cancelDelayedAction: jest.fn(),
  loadPendingActions: jest.fn(),
}));
jest.mock('../../src/backup/orchestrator', () => ({
  verifyBackup: jest.fn(),
}));

import { typedConfirmModal } from '../../src/safety/typed-confirm';
import { scheduleDelayedAction } from '../../src/safety/delay';
import { verifyBackup } from '../../src/backup/orchestrator';

const baseConfig: OperatorConfig = {
  auto_approval: {
    'read-only': 'L3',
    reversible: 'L1',
    'persistent-modifying': 'L0',
    'data-affecting': 'L0',
    architectural: 'L0',
  },
};

interface CtxOptions {
  isAdmin?: boolean;
  skipBackupCheck?: boolean;
}

function makeCtx(opts: CtxOptions = {}): {
  ctx: GateContext;
  events: SafetyAuditEvent[];
} {
  const events: SafetyAuditEvent[] = [];
  const ctx: GateContext = {
    config: baseConfig,
    isAdmin: () => opts.isAdmin === true,
    audit: async (e): Promise<void> => {
      events.push(e);
    },
    flags: opts.skipBackupCheck === true ? { skipBackupCheck: true } : {},
  };
  return { ctx, events };
}

function makeAction(over: Partial<Action> = {}): Action {
  return {
    id: 'act_test_001',
    destructiveness: 'read-only',
    target: { platform: 'proxmox', resource: 'pve-1' },
    description: 'a test action',
    requestedBy: 'pwatson',
    initiatedAt: '2026-05-01T10:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (verifyBackup as jest.Mock).mockResolvedValue({ ok: true, entry: {} });
});

describe('gateApproval — read-only pass-through', () => {
  it('returns approved without any collaborator calls', async () => {
    const { ctx, events } = makeCtx();
    const action = makeAction({ destructiveness: 'read-only' });
    const result = await gateApproval(action, ctx);
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.actionId).toBe(action.id);
      expect(result.approvedBy).toBe('system');
    }
    expect(typedConfirmModal).not.toHaveBeenCalled();
    expect(scheduleDelayedAction).not.toHaveBeenCalled();
    expect(verifyBackup).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('gate.allowed');
    expect(events[0]?.reason).toBe('read-only pass-through');
  });
});

describe('gateApproval — standard flow (reversible/persistent-modifying)', () => {
  it('reversible currently NOT_IMPLEMENTED (PLAN-002-1 wiring pending)', async () => {
    const { ctx } = makeCtx();
    await expect(
      gateApproval(makeAction({ destructiveness: 'reversible' }), ctx),
    ).rejects.toThrow(/NOT_IMPLEMENTED/);
  });

  it('persistent-modifying currently NOT_IMPLEMENTED', async () => {
    const { ctx } = makeCtx();
    await expect(
      gateApproval(makeAction({ destructiveness: 'persistent-modifying' }), ctx),
    ).rejects.toThrow(/NOT_IMPLEMENTED/);
  });
});

describe('gateApproval — data-affecting', () => {
  it('happy path: backup-verified + typed-CONFIRM returns approved', async () => {
    (typedConfirmModal as jest.Mock).mockResolvedValue(true);
    const { ctx, events } = makeCtx();
    const action = makeAction({ destructiveness: 'data-affecting' });
    const result = await gateApproval(action, ctx);
    expect(result.approved).toBe(true);
    expect(verifyBackup).toHaveBeenCalledTimes(1);
    expect(typedConfirmModal).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'gate.allowed')).toBeDefined();
  });

  it('reject path: typed-CONFIRM returns false → ApprovalDeniedError + audit denial', async () => {
    (typedConfirmModal as jest.Mock).mockResolvedValue(false);
    const { ctx, events } = makeCtx();
    const action = makeAction({ destructiveness: 'data-affecting' });
    await expect(gateApproval(action, ctx)).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(events.find((e) => e.type === 'gate.denied')).toBeDefined();
  });

  it('propagates BackupRequiredError when verifyBackup throws', async () => {
    (verifyBackup as jest.Mock).mockRejectedValue(
      new BackupRequiredError('act_test_001', 'proxmox'),
    );
    const { ctx } = makeCtx();
    const action = makeAction({ destructiveness: 'data-affecting' });
    await expect(gateApproval(action, ctx)).rejects.toBeInstanceOf(BackupRequiredError);
    expect(typedConfirmModal).not.toHaveBeenCalled();
  });
});

describe('gateApproval — architectural', () => {
  it('happy path: dry-run + delay + typed-CONFIRM → approved', async () => {
    (typedConfirmModal as jest.Mock).mockResolvedValue(true);
    (scheduleDelayedAction as jest.Mock).mockResolvedValue(undefined);
    const { ctx, events } = makeCtx();
    const action = makeAction({
      destructiveness: 'architectural',
      dryRunReport: 'DRY-RUN: would migrate svc-a, svc-b',
    });
    const result = await gateApproval(action, ctx);
    expect(result.approved).toBe(true);
    expect(verifyBackup).toHaveBeenCalledTimes(1);
    expect(scheduleDelayedAction).toHaveBeenCalledTimes(1);
    expect(scheduleDelayedAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: action.id, delayMs: 24 * 60 * 60 * 1000 }),
    );
    expect(events.find((e) => e.type === 'gate.allowed')).toBeDefined();
  });

  it('throws when dryRunReport is missing', async () => {
    const { ctx } = makeCtx();
    const action = makeAction({ destructiveness: 'architectural' });
    await expect(gateApproval(action, ctx)).rejects.toThrow(/missing required dryRunReport/);
    expect(scheduleDelayedAction).not.toHaveBeenCalled();
  });

  it('throws when dryRunReport is the empty string', async () => {
    const { ctx } = makeCtx();
    const action = makeAction({ destructiveness: 'architectural', dryRunReport: '' });
    await expect(gateApproval(action, ctx)).rejects.toThrow(/missing required dryRunReport/);
  });

  it('rejects with ApprovalDeniedError when typed-CONFIRM returns false post-delay', async () => {
    (typedConfirmModal as jest.Mock).mockResolvedValue(false);
    (scheduleDelayedAction as jest.Mock).mockResolvedValue(undefined);
    const { ctx, events } = makeCtx();
    const action = makeAction({
      destructiveness: 'architectural',
      dryRunReport: 'rep',
    });
    await expect(gateApproval(action, ctx)).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(events.find((e) => e.type === 'gate.denied')).toBeDefined();
  });

  it('propagates BackupRequiredError BEFORE the 24h delay', async () => {
    (verifyBackup as jest.Mock).mockRejectedValue(
      new BackupRequiredError('act_test_001', 'proxmox'),
    );
    const { ctx } = makeCtx();
    const action = makeAction({
      destructiveness: 'architectural',
      dryRunReport: 'rep',
    });
    await expect(gateApproval(action, ctx)).rejects.toBeInstanceOf(BackupRequiredError);
    expect(scheduleDelayedAction).not.toHaveBeenCalled();
  });
});

describe('gateApproval — admin bypass', () => {
  it('admin + skipBackupCheck = bypass + audit gate.bypass', async () => {
    (typedConfirmModal as jest.Mock).mockResolvedValue(true);
    const { ctx, events } = makeCtx({ isAdmin: true, skipBackupCheck: true });
    const action = makeAction({ destructiveness: 'data-affecting' });
    const result = await gateApproval(action, ctx);
    expect(result.approved).toBe(true);
    expect(verifyBackup).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'gate.bypass')).toBeDefined();
  });

  it('non-admin + skipBackupCheck → ApprovalDeniedError', async () => {
    const { ctx } = makeCtx({ isAdmin: false, skipBackupCheck: true });
    const action = makeAction({ destructiveness: 'data-affecting' });
    await expect(gateApproval(action, ctx)).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(verifyBackup).not.toHaveBeenCalled();
    expect(typedConfirmModal).not.toHaveBeenCalled();
  });
});
