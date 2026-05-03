/**
 * 24-hour delay stub for SPEC-002-2-01. The real implementation lands in
 * SPEC-002-2-02 (HMAC-signed, restart-surviving). This module exists so
 * `gate.ts` can import its collaborator by name and tests can mock it.
 */

export interface ScheduleInput {
  actionId: string;
  delayMs: number;
  dryRunReport?: string;
}

export async function scheduleDelayedAction(_input: ScheduleInput): Promise<void> {
  throw new Error('NOT_IMPLEMENTED: scheduleDelayedAction — real impl lands in SPEC-002-2-02');
}

export async function cancelDelayedAction(_actionId: string): Promise<void> {
  throw new Error('NOT_IMPLEMENTED: cancelDelayedAction — real impl lands in SPEC-002-2-02');
}
