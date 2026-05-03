/**
 * `MigrationOrchestrator` per SPEC-002-2-04.
 *
 * Iterates the five phases (identify-resources → plan-target → dry-run
 * → approval-delay → execute), persisting state after every transition
 * so a daemon restart resumes mid-flight.
 *
 * Backup verification happens BEFORE the 24h delay so missing backups
 * fail immediately (failing 24h later is hostile UX).
 */

import { saveMigrationState, loadMigrationState, listInFlightMigrations } from './state-store.js';
import { scheduleDelayedAction, cancelDelayedAction } from '../safety/delay.js';
import { typedConfirmModal } from '../safety/typed-confirm.js';
import { verifyBackup } from '../backup/orchestrator.js';
import { ApprovalDeniedError } from '../safety/errors.js';
import type { Migration, MigrationState, MigrationPhaseName } from './types.js';

export interface PhaseHandlers {
  identifyResources: (m: MigrationState) => Promise<unknown>;
  planTarget: (m: MigrationState) => Promise<unknown>;
  /** Returns the dry-run report text shown to the operator at typed-CONFIRM. */
  dryRun: (m: MigrationState) => Promise<string>;
  execute: (m: MigrationState) => Promise<unknown>;
}

export class MigrationOrchestrator {
  constructor(private readonly handlers: PhaseHandlers) {}

  /** Begin a new migration. Persists initial state, then runs phases. */
  async start(plan: Migration): Promise<MigrationState> {
    const state: MigrationState = {
      ...plan,
      current_phase_index: 0,
      overall_status: 'in-flight',
    };
    await saveMigrationState(state);
    return this.run(state);
  }

  /**
   * Resume a previously-saved migration; called on daemon startup for
   * each in-flight migration. Terminal states return immediately
   * without re-running.
   */
  async resume(migrationId: string): Promise<MigrationState> {
    const state = await loadMigrationState(migrationId);
    if (state.overall_status !== 'in-flight') return state;
    return this.run(state);
  }

  /** Cancel an in-flight migration. Idempotent for terminal states. */
  async cancel(migrationId: string): Promise<void> {
    const state = await loadMigrationState(migrationId);
    if (state.overall_status !== 'in-flight') return;
    // Best-effort cancel of any pending delay timer — no-op if not in
    // approval-delay phase. The promise rejection from cancelDelayedAction
    // is what unblocks the in-flight start() promise.
    try {
      await cancelDelayedAction(migrationId);
    } catch {
      // ignore: cancellation is best-effort.
    }
    state.overall_status = 'cancelled';
    const phase = state.phases[state.current_phase_index];
    if (phase !== undefined) phase.status = 'cancelled';
    await saveMigrationState(state);
  }

  /** List in-flight migrations (for the `migrations status` CLI). */
  async listInFlight(): Promise<MigrationState[]> {
    return listInFlightMigrations();
  }

  private async run(state: MigrationState): Promise<MigrationState> {
    while (state.overall_status === 'in-flight') {
      const phase = state.phases[state.current_phase_index];
      if (phase === undefined) {
        // Defensive: ran off the end of phases without completing.
        state.overall_status = 'complete';
        await saveMigrationState(state);
        break;
      }
      try {
        await this.runPhase(state, phase.name);
      } catch (err) {
        const e = err as Error & { code?: string };
        phase.status = 'failed';
        phase.error = { message: e.message ?? 'unknown', ...(e.code !== undefined ? { code: e.code } : {}) };
        state.overall_status = 'failed';
        await saveMigrationState(state);
        throw err;
      }
    }
    return state;
  }

  private async runPhase(state: MigrationState, phaseName: MigrationPhaseName): Promise<void> {
    const phase = state.phases[state.current_phase_index];
    if (phase === undefined) throw new Error('phase index out of range');
    phase.status = 'in-progress';
    phase.started_at = new Date().toISOString();
    await saveMigrationState(state);

    switch (phaseName) {
      case 'identify-resources':
        phase.output = await this.handlers.identifyResources(state);
        break;
      case 'plan-target':
        phase.output = await this.handlers.planTarget(state);
        break;
      case 'dry-run':
        phase.output = await this.handlers.dryRun(state);
        break;
      case 'approval-delay': {
        // Verify backup BEFORE the delay. Failing 24h later is hostile UX.
        await verifyBackup({ platform: state.source_platform, target: state.source_platform });
        await scheduleDelayedAction({
          actionId: state.migration_id,
          delayMs: state.approval_delay_seconds * 1000,
          dryRunReport: state.phases[2]?.output as string | undefined,
        });
        const dryRunReport = state.phases[2]?.output;
        const ok = await typedConfirmModal({
          message:
            `Migration ${state.migration_id}: ${state.source_platform} -> ${state.target_platform}\n` +
            (typeof dryRunReport === 'string' ? dryRunReport : ''),
          ttl_seconds: 60,
        });
        if (!ok) {
          throw new ApprovalDeniedError(
            state.migration_id,
            'typed-CONFIRM rejected after 24h delay',
          );
        }
        break;
      }
      case 'execute':
        phase.output = await this.handlers.execute(state);
        state.overall_status = 'complete';
        break;
      default: {
        const _exhaustive: never = phaseName;
        throw new Error(`Unknown phase: ${_exhaustive as string}`);
      }
    }

    phase.status = 'complete';
    phase.completed_at = new Date().toISOString();
    state.current_phase_index += 1;
    await saveMigrationState(state);
  }
}
