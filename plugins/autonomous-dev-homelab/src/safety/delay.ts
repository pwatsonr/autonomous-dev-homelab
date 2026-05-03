/**
 * 24-hour delay with HMAC-signed, restart-surviving state files.
 * SPEC-002-2-02.
 *
 * Contract:
 *   - `scheduleDelayedAction({actionId, delayMs, dryRunReport})` persists
 *     a `PendingAction` to `<data>/pending-actions/<id>.json` BEFORE
 *     setting any in-process timer, then resolves when the timer fires.
 *     A crash between persist and timer leaves a recoverable record.
 *   - `cancelDelayedAction(id)` flips status to 'cancelled', clears the
 *     timer, and rejects the in-flight promise. Idempotent.
 *   - `loadPendingActions()` is the daemon-startup entry. Reads every
 *     pending-action JSON, verifies HMAC. On verification failure it
 *     THROWS — daemon refuses to start. This is the fail-closed default
 *     per the plan's risk register: a corrupt state file MUST NOT be
 *     silently dropped.
 *
 * Module-level singletons (`liveTimers`, `pendingResolvers`) assume a
 * single-process daemon. If the daemon ever shards, this becomes a bug —
 * flagged for future redesign.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { signPayload, verifyPayload, type Signed } from './hmac.js';
import { pendingActionPath, pendingActionsDir } from './state-paths.js';

/** Persisted record on disk. Always wrapped in a `Signed<PendingAction>`. */
export interface PendingAction {
  action_id: string;
  /** ISO 8601 — when the action was scheduled. */
  scheduled_at: string;
  /** ISO 8601 — when the timer should fire. */
  fire_at: string;
  delay_ms: number;
  dry_run_report?: string;
  status: 'pending' | 'cancelled' | 'fired';
}

export interface ScheduleInput {
  actionId: string;
  delayMs: number;
  dryRunReport?: string;
}

const liveTimers = new Map<string, NodeJS.Timeout>();
const pendingResolvers = new Map<string, () => void>();
const pendingRejecters = new Map<string, (reason: Error) => void>();

/**
 * Persists state, then sets a `setTimeout(delayMs)` that fires the action.
 * Resolves when the timer fires; rejects with `Error('Action <id> cancelled by operator')`
 * if `cancelDelayedAction` is invoked before the timer fires.
 */
export async function scheduleDelayedAction(input: ScheduleInput): Promise<void> {
  const now = new Date();
  const fireAt = new Date(now.getTime() + input.delayMs);
  const record: PendingAction = {
    action_id: input.actionId,
    scheduled_at: now.toISOString(),
    fire_at: fireAt.toISOString(),
    delay_ms: input.delayMs,
    status: 'pending',
    ...(input.dryRunReport !== undefined ? { dry_run_report: input.dryRunReport } : {}),
  };
  await persist(record);

  return new Promise<void>((resolve, reject) => {
    pendingResolvers.set(input.actionId, resolve);
    pendingRejecters.set(input.actionId, reject);
    const timer = setTimeout(() => {
      void fireAction(input.actionId);
    }, input.delayMs);
    liveTimers.set(input.actionId, timer);
  });
}

/**
 * Marks the action cancelled on disk, clears the timer, and rejects the
 * in-flight promise. Idempotent: cancelling an unknown id, an already-
 * cancelled id, or a fired id is a no-op.
 */
export async function cancelDelayedAction(actionId: string): Promise<void> {
  const existing = await readRecord(actionId);
  if (existing === null || existing.status !== 'pending') return;
  existing.status = 'cancelled';
  await persist(existing);
  const timer = liveTimers.get(actionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    liveTimers.delete(actionId);
  }
  const reject = pendingRejecters.get(actionId);
  if (reject !== undefined) {
    pendingResolvers.delete(actionId);
    pendingRejecters.delete(actionId);
    reject(new Error(`Action ${actionId} cancelled by operator`));
  }
}

/**
 * Daemon-startup entry. Reads every pending-action JSON in
 * `<data>/pending-actions/`. For each:
 *   - HMAC verification fails → THROWS (daemon refuses to start).
 *   - status === 'pending' && fire_at <= now → returned as past-due.
 *   - status === 'pending' && fire_at > now → reschedule remaining time.
 *   - status === 'cancelled' || 'fired' → ignored.
 *
 * Returns the list of pending records that were either rescheduled or
 * are past-due (caller fires them immediately). Cancelled/fired records
 * are NOT included.
 */
export async function loadPendingActions(): Promise<PendingAction[]> {
  const dir = pendingActionsDir();
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  // Deterministic order — prevents flaky tests when readdir's order varies.
  files.sort();
  const restored: PendingAction[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    if (!isSignedPendingAction(raw) || !verifyPayload(raw)) {
      throw new Error(
        `Tampered or corrupt pending-action file: ${f}. ` +
          `Daemon refuses to start until resolved (TDD §8 fail-closed).`,
      );
    }
    const record = raw.payload;
    if (record.status !== 'pending') continue;
    const remaining = new Date(record.fire_at).getTime() - Date.now();
    if (remaining <= 0) {
      // Past-due: caller (daemon entrypoint) is responsible for firing.
      restored.push(record);
      continue;
    }
    const timer = setTimeout(() => {
      void fireAction(record.action_id);
    }, remaining);
    liveTimers.set(record.action_id, timer);
    restored.push(record);
  }
  return restored;
}

async function fireAction(actionId: string): Promise<void> {
  const record = await readRecord(actionId);
  if (record === null || record.status !== 'pending') return;
  record.status = 'fired';
  await persist(record);
  liveTimers.delete(actionId);
  const resolve = pendingResolvers.get(actionId);
  if (resolve !== undefined) {
    pendingResolvers.delete(actionId);
    pendingRejecters.delete(actionId);
    resolve();
  }
}

async function persist(record: PendingAction): Promise<void> {
  const signed = signPayload(record);
  const file = pendingActionPath(record.action_id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(signed, null, 2), { mode: 0o600 });
}

async function readRecord(actionId: string): Promise<PendingAction | null> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(pendingActionPath(actionId), 'utf8'),
    );
    if (!isSignedPendingAction(raw) || !verifyPayload(raw)) {
      throw new Error(`HMAC mismatch on ${actionId}`);
    }
    return raw.payload;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw e;
  }
}

function isSignedPendingAction(v: unknown): v is Signed<PendingAction> {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as { payload?: unknown; hmac?: unknown };
  if (typeof obj.hmac !== 'string') return false;
  if (obj.payload === null || typeof obj.payload !== 'object') return false;
  const p = obj.payload as Partial<PendingAction>;
  return (
    typeof p.action_id === 'string' &&
    typeof p.scheduled_at === 'string' &&
    typeof p.fire_at === 'string' &&
    typeof p.delay_ms === 'number' &&
    (p.status === 'pending' || p.status === 'cancelled' || p.status === 'fired')
  );
}

/**
 * Test-only: clear in-memory timers and resolvers. Does NOT touch disk.
 * Simulates a daemon restart in tests.
 */
export function __resetForTests(): void {
  for (const t of liveTimers.values()) clearTimeout(t);
  liveTimers.clear();
  pendingResolvers.clear();
  pendingRejecters.clear();
}
