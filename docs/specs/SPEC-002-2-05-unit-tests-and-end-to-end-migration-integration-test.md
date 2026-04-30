# SPEC-002-2-05: Unit Tests for Ladder/Gate/Delay/Migration/Backup + End-to-End Migration Integration Test

## Metadata
- **Parent Plan**: PLAN-002-2 (Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration)
- **Tasks Covered**: Task 12 (unit tests for safety + migration modules), Task 13 (end-to-end migration integration test with simulated 24h delay)
- **Future Home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-2-05-unit-tests-and-end-to-end-migration-integration-test.md`
- **Estimated effort**: 8 hours

## Description
Author the test suite that proves PLAN-002-2's safety invariants hold. Two layers:

1. **Unit tests (Task 12):** One file per safety/migration component, exercising every code path. The headline assertion is the **5×4 destructiveness × trust-level truth table** (20 cases) that proves the ladder is enforced as TDD §8 prescribes. Coverage target: ≥ 95% on `src/safety/**`, `src/migration/**`, `src/backup/**`.

2. **Integration test (Task 13):** `tests/integration/test-migration-flow.test.ts` runs a complete migration end-to-end with a fast-forwarded 24h delay (mocked timers). The test exercises the real `MigrationOrchestrator`, real state-store I/O (against a tmp dir), real `scheduleDelayedAction` (with mocked `setTimeout`), and a stubbed typed-CONFIRM that returns `true`. A second variant cancels mid-delay. Test must run in < 30s.

Tests use the project's existing test runner (Vitest based on the autonomous-dev convention; verify in `package.json` before authoring). All tests are deterministic — no real timers, no real time-of-day dependencies, no flaky filesystem assumptions.

The unit-test files were created stub-style by SPEC-002-2-01..04 acceptance criteria; this spec **fills out** those stubs with the truth-table coverage and adds the integration test.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/safety/test-destructiveness-floor.test.ts` | Create | 5×4 truth table for `meetsFloor` + `FLOOR` constant assertions |
| `plugins/autonomous-dev-homelab/tests/safety/test-validator.test.ts` | Create | `validateOperatorConfig` for all 20 combinations |
| `plugins/autonomous-dev-homelab/tests/safety/test-gate.test.ts` | Create | `gateApproval` paths: read-only pass-through, reversible flow, data-affecting (typed-CONFIRM mocked), architectural (delay+CONFIRM mocked), backup-required failure, admin bypass |
| `plugins/autonomous-dev-homelab/tests/safety/test-typed-confirm.test.ts` | Create | Per SPEC-002-2-02 acceptance criteria |
| `plugins/autonomous-dev-homelab/tests/safety/test-delay-persistence.test.ts` | Create | Restart simulation, HMAC tamper rejection, cancel mid-delay |
| `plugins/autonomous-dev-homelab/tests/safety/test-hmac.test.ts` | Create | Sign/verify roundtrip, tamper rejection, secret-env validation |
| `plugins/autonomous-dev-homelab/tests/migration/test-orchestrator.test.ts` | Create | Phase ordering, state persistence, failure path, cancel |
| `plugins/autonomous-dev-homelab/tests/migration/test-schema-validation.test.ts` | Create | JSON schema accepts/rejects per SPEC-002-2-04 acceptance |
| `plugins/autonomous-dev-homelab/tests/backup/test-backup-orchestrator.test.ts` | Create | Missing/stale/fresh/tampered manifest cases |
| `plugins/autonomous-dev-homelab/tests/cli/test-safety-cli.test.ts` | Create | `safety check`, `cancel-action`, `migrations status` exit codes + JSON shapes |
| `plugins/autonomous-dev-homelab/tests/integration/test-migration-flow.test.ts` | Create | End-to-end migration with simulated 24h delay |
| `plugins/autonomous-dev-homelab/tests/fixtures/migration-tdd-section-10-example.json` | Create | TDD §10 example payload, used by schema test |
| `plugins/autonomous-dev-homelab/tests/fixtures/backup-manifest-fresh.json` | Create | Fresh proxmox entry, valid HMAC |
| `plugins/autonomous-dev-homelab/tests/fixtures/backup-manifest-stale.json` | Create | 48h-old proxmox entry, valid HMAC |
| `plugins/autonomous-dev-homelab/tests/fixtures/backup-manifest-tampered.json` | Create | Entry with broken HMAC |
| `plugins/autonomous-dev-homelab/tests/setup/test-env.ts` | Create | Sets HOMELAB_HMAC_SECRET, points HOMELAB_DATA_DIR at a per-test tmp dir |
| `plugins/autonomous-dev-homelab/vitest.config.ts` | Modify (or create) | Coverage thresholds, setup file, test timeout 30s |

## Implementation Details

### Test Environment Setup

```ts
// plugins/autonomous-dev-homelab/tests/setup/test-env.ts
import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'homelab-test-'));
  process.env.HOMELAB_DATA_DIR = tmpRoot;
  process.env.HOMELAB_HMAC_SECRET = 'test-secret-must-be-at-least-32-characters-long';
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});
```

### 5x4 Destructiveness Truth Table (the load-bearing test)

```ts
// plugins/autonomous-dev-homelab/tests/safety/test-destructiveness-floor.test.ts
import { describe, it, expect } from 'vitest';
import { FLOOR, TRUST_RANK, meetsFloor, type Destructiveness, type TrustLevel } from '../../src/safety/destructiveness';

const LEVELS: Destructiveness[] = ['read-only', 'reversible', 'persistent-modifying', 'data-affecting', 'architectural'];
const TRUSTS: TrustLevel[] = ['L0', 'L1', 'L2', 'L3'];

describe('FLOOR mapping (TDD §8)', () => {
  it('maps read-only to L3', () => expect(FLOOR['read-only']).toBe('L3'));
  it('maps reversible to L1', () => expect(FLOOR['reversible']).toBe('L1'));
  it('maps persistent-modifying to L0', () => expect(FLOOR['persistent-modifying']).toBe('L0'));
  it('maps data-affecting to L0', () => expect(FLOOR['data-affecting']).toBe('L0'));
  it('maps architectural to L0', () => expect(FLOOR['architectural']).toBe('L0'));
  it('FLOOR is frozen', () => { expect(Object.isFrozen(FLOOR)).toBe(true); });
});

describe('meetsFloor truth table (5 destructiveness x 4 trust = 20 cases)', () => {
  for (const dest of LEVELS) {
    for (const trust of TRUSTS) {
      const required = FLOOR[dest];
      const expected = TRUST_RANK[trust] <= TRUST_RANK[required];
      it(`${dest} configured at ${trust}: ${expected ? 'allowed' : 'denied'}`, () => {
        expect(meetsFloor(trust, required)).toBe(expected);
      });
    }
  }
});
```

This generates all 20 named test cases automatically. Asserted outcomes per the TDD-§8 floor mapping:

| Destructiveness         | L0 | L1 | L2 | L3 |
| ----------------------- | -- | -- | -- | -- |
| `read-only` (floor L3)  |  Y |  Y |  Y |  Y |
| `reversible` (floor L1) |  Y |  Y |  N |  N |
| `persistent-mod` (L0)   |  Y |  N |  N |  N |
| `data-affecting` (L0)   |  Y |  N |  N |  N |
| `architectural` (L0)    |  Y |  N |  N |  N |

(Where Y = configured trust meets/exceeds floor strictness, N = below floor.)

### Validator Test Pattern

```ts
// plugins/autonomous-dev-homelab/tests/safety/test-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateOperatorConfig } from '../../src/safety/validator';
import { FLOOR, TRUST_RANK, type Destructiveness, type TrustLevel } from '../../src/safety/destructiveness';
import { ConfigurationError } from '../../src/safety/errors';

const LEVELS: Destructiveness[] = ['read-only', 'reversible', 'persistent-modifying', 'data-affecting', 'architectural'];
const TRUSTS: TrustLevel[] = ['L0', 'L1', 'L2', 'L3'];

function configWith(level: Destructiveness, trust: TrustLevel) {
  const cfg: Record<Destructiveness, TrustLevel> = {
    'read-only': 'L3', 'reversible': 'L1', 'persistent-modifying': 'L0', 'data-affecting': 'L0', 'architectural': 'L0',
  };
  cfg[level] = trust;
  return { auto_approval: cfg };
}

describe('validateOperatorConfig (5x4 = 20 cases)', () => {
  for (const dest of LEVELS) {
    for (const trust of TRUSTS) {
      const required = FLOOR[dest];
      const meets = TRUST_RANK[trust] <= TRUST_RANK[required];
      it(`auto_approval.${dest}=${trust} ${meets ? 'accepts' : 'throws CONFIG_BELOW_FLOOR'}`, () => {
        if (meets) expect(() => validateOperatorConfig(configWith(dest, trust))).not.toThrow();
        else {
          try { validateOperatorConfig(configWith(dest, trust)); throw new Error('expected throw'); }
          catch (e: any) {
            expect(e).toBeInstanceOf(ConfigurationError);
            expect(e.code).toBe('CONFIG_BELOW_FLOOR');
            expect(e.details.destructiveness).toBe(dest);
          }
        }
      });
    }
  }
});

describe('validator edge cases', () => {
  it('throws on missing auto_approval entry', () => {
    expect(() => validateOperatorConfig({ auto_approval: {} as any })).toThrow(ConfigurationError);
  });
});
```

### Integration Test (Task 13) — The Headline Test

```ts
// plugins/autonomous-dev-homelab/tests/integration/test-migration-flow.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MigrationOrchestrator } from '../../src/migration/orchestrator';
import { __setPromptLine } from '../../src/safety/io-stdin';
import type { Migration } from '../../src/migration/types';
import { writeFreshBackupManifest } from '../helpers/backup-manifest';   // helper that writes fixture into tmp HOMELAB_DATA_DIR
import { ulid } from '../helpers/ulid';

describe('Migration end-to-end flow with simulated 24h delay', () => {
  it('runs all 5 phases, enforces 24h delay via fake timers, requires CONFIRM, completes', async () => {
    vi.useFakeTimers();
    await writeFreshBackupManifest('portainer');                          // satisfies backup verification

    __setPromptLine(async () => 'CONFIRM');                                // typed-CONFIRM returns true after delay

    const handlers = {
      identifyResources: vi.fn(async () => ({ resources: ['svc-a', 'svc-b'] })),
      planTarget:        vi.fn(async () => ({ target: 'k3s-cluster-1' })),
      dryRun:            vi.fn(async () => 'DRY-RUN: would migrate svc-a, svc-b to k3s'),
      execute:           vi.fn(async () => ({ executed: true })),
    };
    const orch = new MigrationOrchestrator(handlers);

    const plan: Migration = {
      migration_id: ulid(),
      source_platform: 'portainer',
      target_platform: 'k3s',
      classification: 'architectural',
      description: 'Portainer to K3s',
      initiated_by: 'test-operator',
      initiated_at: new Date().toISOString(),
      approval_delay_seconds: 86_400,
      requires_typed_confirm: true,
      phases: [
        { name: 'identify-resources', status: 'pending' },
        { name: 'plan-target',        status: 'pending' },
        { name: 'dry-run',            status: 'pending' },
        { name: 'approval-delay',     status: 'pending' },
        { name: 'execute',            status: 'pending' },
      ],
    };

    const startPromise = orch.start(plan);
    // The orchestrator schedules a 24h timer inside the approval-delay phase.
    // Advance through it.
    await vi.advanceTimersByTimeAsync(86_400_000);
    const result = await startPromise;

    expect(result.overall_status).toBe('complete');
    expect(handlers.identifyResources).toHaveBeenCalledOnce();
    expect(handlers.planTarget).toHaveBeenCalledOnce();
    expect(handlers.dryRun).toHaveBeenCalledOnce();
    expect(handlers.execute).toHaveBeenCalledOnce();
    expect(result.phases.every((p) => p.status === 'complete')).toBe(true);
    expect(result.phases.map((p) => p.name)).toEqual([
      'identify-resources', 'plan-target', 'dry-run', 'approval-delay', 'execute',
    ]);

    vi.useRealTimers();
    __setPromptLine(undefined);
  }, 30_000);

  it('cancel during the 24h delay aborts the migration', async () => {
    vi.useFakeTimers();
    await writeFreshBackupManifest('portainer');
    __setPromptLine(async () => 'CONFIRM');

    const handlers = {
      identifyResources: vi.fn(async () => ({})),
      planTarget:        vi.fn(async () => ({})),
      dryRun:            vi.fn(async () => 'dry-run'),
      execute:           vi.fn(async () => ({ executed: true })),
    };
    const orch = new MigrationOrchestrator(handlers);
    const plan: Migration = { /* same shape as above; new ULID */ } as any;

    const startPromise = orch.start(plan);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);                // 12h elapsed
    await orch.cancel(plan.migration_id);
    await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000);                // remaining 13h (would have fired)

    await expect(startPromise).rejects.toThrow();
    expect(handlers.execute).not.toHaveBeenCalled();

    vi.useRealTimers();
    __setPromptLine(undefined);
  }, 30_000);
});
```

### Vitest Config

```ts
// plugins/autonomous-dev-homelab/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/test-env.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/safety/**', 'src/migration/**', 'src/backup/**', 'src/cli/commands/{safety,cancel-action,migrations}.ts'],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
```

## Acceptance Criteria

### Unit Tests
- [ ] `test-destructiveness-floor.test.ts` generates 20 named test cases (5 destructiveness × 4 trust). All pass.
- [ ] `FLOOR` is verified frozen (Object.isFrozen returns true).
- [ ] `test-validator.test.ts` covers the 20 truth-table combinations PLUS a missing-config case. The 12 below-floor combinations throw `ConfigurationError` with `code === 'CONFIG_BELOW_FLOOR'`. The 8 at-or-above combinations do not throw.
- [ ] `test-gate.test.ts` covers: read-only pass-through (no collaborator calls); reversible standard flow (mocked); data-affecting happy path (typed-CONFIRM = true); data-affecting reject (typed-CONFIRM = false → ApprovalDeniedError); architectural happy path (delay + CONFIRM); architectural missing dry-run report (throw); backup-required failure (BackupRequiredError); admin bypass (`--skip-backup-check` + admin = true → bypass + audit emitted); admin bypass without admin (throw).
- [ ] `test-typed-confirm.test.ts` covers all SPEC-002-2-02 typed-CONFIRM acceptance criteria (CONFIRM/confirm/yes/timeout/EOF/custom expectedWord).
- [ ] `test-delay-persistence.test.ts` covers: schedule + advance timer fires; cancel mid-delay rejects pending promise + state file updated; restart at T+12h via `__resetForTests` then `loadPendingActions`, advance another 12h, fires; tampered file throws on load; past-due action returned in restored list.
- [ ] `test-hmac.test.ts` covers: sign/verify roundtrip; tamper rejected; secret-env unset throws; secret-env < 32 chars throws; deterministic signature for same input.
- [ ] `test-orchestrator.test.ts` covers: 5-phase ordering; state persisted at each transition; failure path (handler throws → phase status = failed, overall = failed); cancel mid-flight; resume from in-flight state.
- [ ] `test-schema-validation.test.ts` validates the TDD §10 fixture; rejects missing required fields; rejects `classification: 'reversible'`; rejects `requires_typed_confirm: false`; rejects phases array with wrong length; rejects `approval_delay_seconds < 3600`.
- [ ] `test-backup-orchestrator.test.ts` covers: missing manifest → BackupRequiredError; fresh manifest → ok; stale manifest → BackupRequiredError with age; tampered manifest → throws; freshness override accepted; freshest of multiple entries selected.
- [ ] `test-safety-cli.test.ts` covers: `safety check` for each destructiveness; `--json` flag output shape; `cancel-action` calls cancelDelayedAction + writes audit entry; `migrations status` for in-flight + specific id + JSON mode; `remaining_seconds` is null outside approval-delay.

### Coverage Threshold
- [ ] `vitest run --coverage` reports ≥ 95% statements, ≥ 90% branches, ≥ 95% functions, ≥ 95% lines on the `src/safety/**`, `src/migration/**`, `src/backup/**`, and the three CLI command files.
- [ ] Coverage report (lcov) is emitted to a path the CI can pick up.

### Integration Test (Task 13)
- [ ] `test-migration-flow.test.ts` runs in < 30s (verified by Vitest test timeout AND wall-clock observation).
- [ ] Happy-path test: orchestrator runs all 5 phases in order; `vi.advanceTimersByTimeAsync(86_400_000)` advances through the 24h delay deterministically; final `overall_status === 'complete'`; all 4 phase handlers called exactly once.
- [ ] Cancel-during-delay test: cancel at T+12h; advance another 13h; the start promise rejects (Error message contains "cancelled"); `execute` handler never called.
- [ ] Both tests use real `MigrationOrchestrator`, real state-store I/O (against a per-test tmp dir), real `scheduleDelayedAction`/`cancelDelayedAction` with mocked timers, and a stubbed typed-CONFIRM (via `__setPromptLine`).
- [ ] State-file inspection: after each phase completes in the happy-path test, the migration JSON on disk reflects the updated phase status. Verified by re-reading the file at the end and asserting all 5 phases have `status === 'complete'`.

### Determinism
- [ ] Tests do NOT use `Date.now()` directly without mocking. Where time-of-day matters, tests use `vi.setSystemTime` or fixture timestamps.
- [ ] Tests do NOT depend on file-system ordering (tests sort `readdir` output if order matters).
- [ ] Tests do NOT use real network calls. Backup manifest reads are file-only; HTTP mocking is not required for this spec.
- [ ] Running the suite 10x in a row produces 10 identical pass results (verified by ad-hoc CI script or local check).

### Test Hygiene
- [ ] Each test file resets module-level state via the `__resetForTests` / `__setPromptLine` hooks where applicable, in `afterEach`.
- [ ] No leaked timers (Vitest reports zero unhandled timers at suite end).
- [ ] No leaked file handles (per-test tmp dir is cleaned up in afterEach via the setup file).

## Dependencies

- **SPEC-002-2-01** — `validateOperatorConfig`, `gateApproval`, `FLOOR`, `meetsFloor`, error classes.
- **SPEC-002-2-02** — `typedConfirmModal`, `scheduleDelayedAction`, `cancelDelayedAction`, `signPayload`/`verifyPayload`, `__setPromptLine`, `__resetForTests`.
- **SPEC-002-2-04** — `MigrationOrchestrator`, `verifyBackup`, migration JSON schema, CLI commands.
- Vitest (already a dep of autonomous-dev plugins; verify in homelab `package.json` and add if missing).
- `ulid` package OR a deterministic test-only ULID helper.
- `ajv` for JSON schema test (only if not already a dep).

## Notes

- **Run unit tests in isolation first.** Each component test file should pass without the others present. The integration test depends on all four prior specs being implemented; if it fails before unit tests pass, fix unit tests first.
- **The 5×4 truth table is generated, not hand-written.** This is intentional: as the FLOOR table evolves (e.g., a new destructiveness level), the test naturally extends. Hand-rolled truth tables silently miss new combinations.
- **Fake timers in Vitest are the right tool here.** `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(N)` deterministically advances through `setTimeout`. The 24h delay test runs in milliseconds because no real time passes.
- **Per-test tmp dir is essential.** Tests that read/write `<homelab-data>/pending-actions/` and `<homelab-data>/migrations/` MUST NOT collide across parallel runs. The `tests/setup/test-env.ts` file creates a fresh dir in `beforeEach` and removes it in `afterEach`. If Vitest's default parallelism causes flakes, set `--no-file-parallelism` for these suites.
- **HMAC secret in test env is hardcoded.** It is 36 chars (above the 32-char minimum). Production must use a proper secret manager; the test value is deliberately obvious so it never leaks into prod.
- **The integration test's "cancel during delay" variant is the most subtle.** The pending promise from `start()` must reject after `cancel()` is called. If the orchestrator swallows the cancellation, the test will time out at 30s and fail loudly — which is the desired failure mode. Do not retry-loop the test on timeout; investigate.
- **Coverage thresholds are gate-keepers.** PR cannot merge if coverage drops below 95%. If a code path is genuinely untestable (extremely rare), exempt it via an inline `/* c8 ignore next */` comment with a justification — but prefer to find a way to test it.
- **Performance budget:** Full unit suite should run in < 10s on a developer laptop. The integration suite (2 tests) in < 30s. If either exceeds budget after the initial implementation, profile before optimizing.
