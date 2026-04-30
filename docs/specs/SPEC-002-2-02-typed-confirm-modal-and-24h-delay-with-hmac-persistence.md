# SPEC-002-2-02: Typed-CONFIRM Modal + 24-Hour Delay with HMAC-Signed Persistence

## Metadata
- **Parent Plan**: PLAN-002-2 (Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration)
- **Tasks Covered**: Task 4 (typed-CONFIRM modal), Task 5 (24-hour delay with HMAC-signed persistence across daemon restarts)
- **Future Home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-2-02-typed-confirm-modal-and-24h-delay-with-hmac-persistence.md`
- **Estimated effort**: 6.5 hours

## Description
Implement the two safety primitives that block destructive actions behind unmistakable operator intent: (1) a **typed-CONFIRM modal** that requires the operator to type the literal word `CONFIRM` (not "yes", not "y", not lowercase) before any data-affecting or architectural action proceeds; and (2) a **24-hour delay** for architectural actions that survives daemon restarts via HMAC-signed state files persisted to disk.

These primitives are consumed by `gateApproval` (SPEC-002-2-01). They must be testable in isolation with mocked stdin and mocked timers. The 24h delay must enforce its full window even if the daemon restarts mid-delay: state file records `scheduled_at` and `fire_at`, and on daemon boot any pending action with `fire_at <= now` fires immediately while any future-dated action is rescheduled with the remaining time.

State files are HMAC-signed (HMAC-SHA256 over the canonical JSON of the payload, with a secret loaded from an env var) so a tampered file is rejected. Per the plan's risk register, daemon refuses to start if any pending-action file has a broken HMAC; this is a fail-closed default that produces a loud operator-visible escalation rather than silently dropping the pending action.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/safety/typed-confirm.ts` | Create | `typedConfirmModal({message, ttl_seconds})` — Promise<boolean> |
| `plugins/autonomous-dev-homelab/src/safety/delay.ts` | Create | `scheduleDelayedAction`, `cancelDelayedAction`, `loadPendingActions` |
| `plugins/autonomous-dev-homelab/src/safety/hmac.ts` | Create | `signPayload(obj)`, `verifyPayload(obj)` — HMAC-SHA256 helpers |
| `plugins/autonomous-dev-homelab/src/safety/state-paths.ts` | Create | Resolve `<homelab-data>/pending-actions/<id>.json` paths |
| `plugins/autonomous-dev-homelab/src/safety/io-stdin.ts` | Create | Thin abstraction over stdin (readline or readline/promises) for testability |

## Implementation Details

### Typed-CONFIRM Modal

```ts
// plugins/autonomous-dev-homelab/src/safety/typed-confirm.ts
import { promptLine } from './io-stdin';

export interface TypedConfirmInput {
  message: string;
  ttl_seconds: number;        // default 60 (validated upstream by gate)
  expectedWord?: string;      // default 'CONFIRM' (case-sensitive); overridable for tests only
}

/**
 * Prompts the operator and resolves true ONLY if they type the literal expected word
 * (default 'CONFIRM') within ttl_seconds. Any other input (including lowercase variants,
 * whitespace-padded variants, or no input) resolves false.
 *
 * Resolution rules:
 *   - Input === expectedWord (strict equality, no trim)               -> true
 *   - Input is anything else                                          -> false
 *   - No input within ttl_seconds                                     -> false (timeout)
 *   - Stdin closes (EOF) before input received                        -> false
 */
export async function typedConfirmModal(input: TypedConfirmInput): Promise<boolean> {
  const expected = input.expectedWord ?? 'CONFIRM';
  const ttlMs = input.ttl_seconds * 1000;

  const prompt = `\n${input.message}\nType ${expected} (case-sensitive) within ${input.ttl_seconds}s to proceed: `;

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ttlMs);
    promptLine(prompt)
      .then((answer) => {
        clearTimeout(timer);
        resolve(answer === expected);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    timer.unref?.();
  });
}
```

### Stdin Abstraction (for testability)

```ts
// plugins/autonomous-dev-homelab/src/safety/io-stdin.ts
import * as readline from 'node:readline/promises';

let injected: ((prompt: string) => Promise<string>) | undefined;

/** Test hook: inject a mock prompter. Pass undefined to clear. */
export function __setPromptLine(fn: typeof injected): void {
  injected = fn;
}

export async function promptLine(prompt: string): Promise<string> {
  if (injected) return injected(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
```

### HMAC Helpers

```ts
// plugins/autonomous-dev-homelab/src/safety/hmac.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function getSecret(envVar = 'HOMELAB_HMAC_SECRET'): Buffer {
  const v = process.env[envVar];
  if (!v || v.length < 32) {
    throw new Error(`${envVar} must be set and >= 32 chars (got ${v?.length ?? 0}).`);
  }
  return Buffer.from(v, 'utf8');
}

/** Canonical JSON: keys sorted recursively, no whitespace. Signs the canonical bytes. */
export function signPayload<T extends object>(payload: T, envVar?: string): { payload: T; hmac: string } {
  const canonical = canonicalize(payload);
  const sig = createHmac('sha256', getSecret(envVar)).update(canonical).digest('hex');
  return { payload, hmac: sig };
}

/** Returns true iff the hmac matches a fresh signature over the canonical payload. */
export function verifyPayload<T extends object>(signed: { payload: T; hmac: string }, envVar?: string): boolean {
  const expected = createHmac('sha256', getSecret(envVar)).update(canonicalize(signed.payload)).digest();
  const actual = Buffer.from(signed.hmac, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize((v as Record<string, unknown>)[k])).join(',') + '}';
}
```

### 24-Hour Delay (HMAC-Signed, Restart-Surviving)

```ts
// plugins/autonomous-dev-homelab/src/safety/delay.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { signPayload, verifyPayload } from './hmac';
import { pendingActionPath, pendingActionsDir } from './state-paths';

export interface PendingAction {
  action_id: string;
  scheduled_at: string;       // ISO 8601
  fire_at: string;            // ISO 8601 (scheduled_at + delayMs)
  delay_ms: number;
  dry_run_report?: string;
  status: 'pending' | 'cancelled' | 'fired';
}

const liveTimers = new Map<string, NodeJS.Timeout>();
const pendingResolvers = new Map<string, () => void>();
const pendingRejecters = new Map<string, (reason: Error) => void>();

export interface ScheduleInput {
  actionId: string;
  delayMs: number;
  dryRunReport?: string;
}

/**
 * Resolves when the delay completes (action fires). Rejects if cancelled.
 * Persists state to disk before any timer is set so a crash before scheduling
 * still leaves a recoverable record.
 */
export async function scheduleDelayedAction(input: ScheduleInput): Promise<void> {
  const now = new Date();
  const fireAt = new Date(now.getTime() + input.delayMs);
  const record: PendingAction = {
    action_id: input.actionId,
    scheduled_at: now.toISOString(),
    fire_at: fireAt.toISOString(),
    delay_ms: input.delayMs,
    dry_run_report: input.dryRunReport,
    status: 'pending',
  };
  await persist(record);

  return new Promise<void>((resolve, reject) => {
    pendingResolvers.set(input.actionId, resolve);
    pendingRejecters.set(input.actionId, reject);
    const timer = setTimeout(() => fireAction(input.actionId), input.delayMs);
    liveTimers.set(input.actionId, timer);
  });
}

/**
 * Marks the action cancelled on disk and rejects the pending promise.
 * Idempotent: cancelling an already-cancelled action is a no-op.
 */
export async function cancelDelayedAction(actionId: string): Promise<void> {
  const existing = await readRecord(actionId);
  if (!existing || existing.status !== 'pending') return;
  existing.status = 'cancelled';
  await persist(existing);
  const timer = liveTimers.get(actionId);
  if (timer) { clearTimeout(timer); liveTimers.delete(actionId); }
  const reject = pendingRejecters.get(actionId);
  if (reject) {
    pendingResolvers.delete(actionId);
    pendingRejecters.delete(actionId);
    reject(new Error(`Action ${actionId} cancelled by operator`));
  }
}

/**
 * Called once at daemon startup. Reads every state file in the pending-actions
 * directory; for each pending record:
 *   - HMAC verification fails -> daemon refuses to start (throws)
 *   - status === 'pending' && fire_at <= now -> fire immediately
 *   - status === 'pending' && fire_at > now  -> reschedule with remaining time
 *   - status === 'cancelled' || 'fired'      -> ignored (left for audit)
 *
 * Returns the list of records that were rescheduled.
 */
export async function loadPendingActions(): Promise<PendingAction[]> {
  const dir = pendingActionsDir();
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  const restored: PendingAction[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    if (!verifyPayload(raw)) {
      throw new Error(`Tampered or corrupt pending-action file: ${f}. Daemon refuses to start until resolved (TDD §8 fail-closed).`);
    }
    const record = raw.payload as PendingAction;
    if (record.status !== 'pending') continue;
    const remaining = new Date(record.fire_at).getTime() - Date.now();
    if (remaining <= 0) {
      // Past-due: fire immediately. Resolution will be picked up by whoever called scheduleDelayedAction
      // pre-restart -- but since that promise is gone, callers must check on startup.
      // For SPEC-002-2-02, we surface restored actions to the caller; the daemon entrypoint
      // re-creates the gateApproval continuation by replaying from this list.
      restored.push(record);
      continue;
    }
    const timer = setTimeout(() => fireAction(record.action_id), remaining);
    liveTimers.set(record.action_id, timer);
    restored.push(record);
  }
  return restored;
}

async function fireAction(actionId: string): Promise<void> {
  const record = await readRecord(actionId);
  if (!record || record.status !== 'pending') return;
  record.status = 'fired';
  await persist(record);
  liveTimers.delete(actionId);
  const resolve = pendingResolvers.get(actionId);
  if (resolve) {
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
    const raw = JSON.parse(await fs.readFile(pendingActionPath(actionId), 'utf8'));
    if (!verifyPayload(raw)) throw new Error(`HMAC mismatch on ${actionId}`);
    return raw.payload as PendingAction;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

/** Test-only: clear in-memory timers/resolvers. Does NOT touch disk. */
export function __resetForTests(): void {
  for (const t of liveTimers.values()) clearTimeout(t);
  liveTimers.clear();
  pendingResolvers.clear();
  pendingRejecters.clear();
}
```

### State-Path Resolver

```ts
// plugins/autonomous-dev-homelab/src/safety/state-paths.ts
import * as path from 'node:path';

/** Reads CLAUDE_PLUGIN_DATA / HOMELAB_DATA_DIR; defaults to ./.homelab-data */
function dataDir(): string {
  return process.env.HOMELAB_DATA_DIR ?? process.env.CLAUDE_PLUGIN_DATA ?? path.resolve(process.cwd(), '.homelab-data');
}
export function pendingActionsDir(): string {
  return path.join(dataDir(), 'pending-actions');
}
export function pendingActionPath(actionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(actionId)) throw new Error(`Invalid action_id: ${actionId}`);
  return path.join(pendingActionsDir(), `${actionId}.json`);
}
```

## Acceptance Criteria

### Typed-CONFIRM
- [ ] `typedConfirmModal({message: 'X', ttl_seconds: 60})` with mocked stdin returning `'CONFIRM'` resolves to `true`.
- [ ] Same call with stdin returning `'confirm'` (lowercase) resolves to `false`.
- [ ] Same call with stdin returning `'CONFIRM '` (trailing space) resolves to `false` (no trimming).
- [ ] Same call with stdin returning `'yes'` resolves to `false`.
- [ ] Same call with stdin never returning (timer advanced beyond `ttl_seconds * 1000`) resolves to `false`.
- [ ] Same call with stdin closing (EOF) before input resolves to `false`.
- [ ] Custom `expectedWord: 'DELETE'` accepts `'DELETE'` and rejects `'CONFIRM'`.
- [ ] After resolution, no readline interface remains open (verified via process listener count or by calling twice in sequence without hangs).

### 24h Delay — Happy Path
- [ ] `scheduleDelayedAction({actionId: 'A', delayMs: 86_400_000})` writes a state file at `<data>/pending-actions/A.json`.
- [ ] State file content has `payload.action_id === 'A'`, `payload.delay_ms === 86_400_000`, `payload.status === 'pending'`, and a non-empty `hmac` field.
- [ ] State file mode is `0o600` (operator-only readable on Unix).
- [ ] After advancing mocked timer by 86_400_000 ms, the promise resolves; the state file's `status` field updates to `'fired'`.

### 24h Delay — Cancellation
- [ ] `cancelDelayedAction('A')` while pending: state file `status` becomes `'cancelled'`; the in-flight promise rejects with `Error: Action A cancelled by operator`.
- [ ] `cancelDelayedAction('A')` after the action already fired: no-op, no throw.
- [ ] `cancelDelayedAction('NONEXISTENT')`: no-op, no throw.

### 24h Delay — Restart Persistence (the load-bearing test)
- [ ] Schedule action `A` with `delayMs = 24h`. Advance mocked clock by 12h. Call `__resetForTests()` (simulates daemon process death). Call `loadPendingActions()`. The returned array contains record `A` with the same `fire_at` as before.
- [ ] After `loadPendingActions()` runs, advancing the mocked clock by another 12h causes the loaded timer to fire (state file's `status` becomes `'fired'`).
- [ ] Schedule action `B` with `delayMs = 24h`. Advance mocked clock by 25h. Restart. `loadPendingActions()` returns `B` and the daemon entrypoint must fire it immediately (verified by record having `status === 'fired'` after firing logic runs).
- [ ] Cancelled records are NOT included in the restored list.
- [ ] Fired records are NOT included in the restored list.

### 24h Delay — HMAC Tampering
- [ ] Manually edit a pending-action JSON file's `payload.fire_at` after writing. Calling `loadPendingActions()` THROWS with message containing "Tampered or corrupt pending-action file" and the filename.
- [ ] Manually edit the `hmac` field. Calling `loadPendingActions()` THROWS as above.
- [ ] Daemon entrypoint test: when `loadPendingActions()` throws, the daemon does NOT start (process exits non-zero or supervising entry rethrows).
- [ ] HMAC verification uses `timingSafeEqual` (verified by code review; tests do not need to detect timing).
- [ ] `signPayload` and `verifyPayload` produce/verify deterministic signatures: signing the same payload twice produces the same hmac.

### Path & Env Safety
- [ ] `pendingActionPath('A; rm -rf /')` throws `Error: Invalid action_id` (regex rejects shell-meta chars).
- [ ] When `HOMELAB_HMAC_SECRET` is unset or < 32 chars, `signPayload` throws with a clear message naming the env var.

### Coverage
- [ ] Coverage on `typed-confirm.ts`, `delay.ts`, `hmac.ts`, and `state-paths.ts` is ≥ 95%.

## Dependencies

- **SPEC-002-2-01** consumes `typedConfirmModal` and `scheduleDelayedAction` from this spec.
- **SPEC-002-2-04** consumes `cancelDelayedAction` from this spec (called by `homelab cancel-action <id>` CLI).
- Node `node:crypto` (`createHmac`, `timingSafeEqual`), `node:fs/promises`, `node:path`, `node:readline/promises` — standard library.
- Env vars: `HOMELAB_HMAC_SECRET` (required), `HOMELAB_DATA_DIR` or `CLAUDE_PLUGIN_DATA` (data dir override).

## Notes

- **Do not trim input.** A common bug is to call `.trim()` before comparing — that lets `' CONFIRM\n'` succeed. The strict equality is intentional friction.
- **HMAC secret rotation is not in scope here.** A future plan can add dual-secret verification (accept either old or new); for MVP, rotating the secret invalidates all pending actions.
- **The fail-closed restart behavior is critical.** Per the plan's risk register: a corrupt state file MUST NOT be silently dropped. The trade-off is deliberate — losing a pending architectural change is bad, but firing one without operator review is catastrophic. Daemon refusal forces operator attention.
- The `restored` return value from `loadPendingActions` is consumed by the daemon entrypoint (lives outside this spec) to re-attach the gateApproval continuation. For past-due actions, the daemon's policy is to fire them but flag them in the audit log as "fired post-restart" so operators see the lapse.
- `setTimeout` in Node fires at most after the requested delay; clock-skew correction during the window is not in scope. If the system clock is rolled back, timers do not retroactively reschedule. Operator-time-skew is a known limitation; documented in operator README.
- The `liveTimers` and `pendingResolvers` maps are module-level singletons. This is safe because the daemon is a single process. If we ever shard the daemon, this becomes a bug — flagged for future redesign.
- The `__resetForTests` and `__setPromptLine` exports are test hooks. They MUST NOT be called from production code; convention enforced by the leading double-underscore.
