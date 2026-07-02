/**
 * Safety CLI tests: `safety check`, `cancel-action`, `migrations status`.
 * SPEC-002-2-05.
 *
 * Strategy: build each subcommand directly via its `build*` factory and
 * invoke via `parseAsync(['<args>'], { from: 'user' })`. Inject test
 * doubles for store/audit/cancel callbacks so we never touch real disk
 * state. (The state-store path is exercised in the orchestrator suite.)
 */

import { buildSafetyCommand, runSafetyCheck } from '../../src/cli/commands/safety';
import {
  buildCancelActionCommand,
  runCancelAction,
  type CancelAuditEvent,
} from '../../src/cli/commands/cancel-action';
import { buildMigrationsCommand, runMigrationsStatus } from '../../src/cli/commands/migrations';
import type { Destructiveness } from '../../src/safety/destructiveness';
import type { MigrationState } from '../../src/migration/types';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams(): {
  captured: CapturedStreams;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const captured: CapturedStreams = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s) => {
        captured.stdout += s;
      },
      stderr: (s) => {
        captured.stderr += s;
      },
    },
  };
}

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('safety check CLI', () => {
  it('prints destructiveness, floor, and required approvals (text mode)', async () => {
    const { captured, streams } = captureStreams();
    const handle = buildSafetyCommand({
      loadAction: async (id) => ({ id, destructiveness: 'data-affecting' as Destructiveness }),
      streams,
    });
    await handle.command.parseAsync(['check', 'act-1'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toMatch(/destructiveness: data-affecting/);
    expect(captured.stdout).toMatch(/floor: L0/);
    expect(captured.stdout).toMatch(/typed-CONFIRM/);
  });

  it('prints --json shape', async () => {
    const r = await runSafetyCheck(
      'act-2',
      { json: true },
      {
        loadAction: async (id) => ({ id, destructiveness: 'architectural' as Destructiveness }),
        streams: { stdout: () => undefined, stderr: () => undefined },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.result).toEqual({
      action_id: 'act-2',
      destructiveness: 'architectural',
      floor: 'L0',
      required_approvals: ['dry-run', '24h delay', 'typed-CONFIRM', 'backup verification'],
    });
  });

  it('returns no required approvals for read-only', async () => {
    const r = await runSafetyCheck(
      'act-ro',
      { json: true },
      {
        loadAction: async (id) => ({ id, destructiveness: 'read-only' as Destructiveness }),
        streams: { stdout: () => undefined, stderr: () => undefined },
      },
    );
    expect(r.result?.floor).toBe('L3');
    expect(r.result?.required_approvals).toEqual([]);
  });

  it('exits with usage error when action is not found', async () => {
    const { captured, streams } = captureStreams();
    const handle = buildSafetyCommand({
      loadAction: async () => null,
      streams,
    });
    await handle.command.parseAsync(['check', 'missing'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toMatch(/not found/);
  });

  describe('per-destructiveness coverage', () => {
    const cases: Destructiveness[] = [
      'read-only',
      'reversible',
      'persistent-modifying',
      'data-affecting',
      'architectural',
    ];
    for (const dest of cases) {
      it(`reports floor for ${dest}`, async () => {
        const r = await runSafetyCheck(
          'a',
          { json: true },
          {
            loadAction: async (id) => ({ id, destructiveness: dest }),
            streams: { stdout: () => undefined, stderr: () => undefined },
          },
        );
        expect(r.exitCode).toBe(0);
        expect(r.result?.destructiveness).toBe(dest);
      });
    }
  });
});

describe('cancel-action CLI', () => {
  it('calls injected cancel + writes audit entry', async () => {
    const cancel = jest.fn(async () => undefined);
    const audit = jest.fn<Promise<void>, [CancelAuditEvent]>(async () => undefined);
    const { captured, streams } = captureStreams();
    const handle = buildCancelActionCommand({ cancel, audit, streams });
    await handle.command.parseAsync(['act-1'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(cancel).toHaveBeenCalledWith('act-1');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({
      type: 'action.cancelled',
      action_id: 'act-1',
    });
    expect(captured.stdout).toMatch(/cancelled/);
  });

  it('emits JSON shape with --json', async () => {
    const cancel = jest.fn(async () => undefined);
    const { captured, streams } = captureStreams();
    const handle = buildCancelActionCommand({ cancel, streams });
    await handle.command.parseAsync(['act-2', '--json'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { action_id: string; status: string };
    expect(parsed).toEqual({ action_id: 'act-2', status: 'cancelled' });
  });

  it('runCancelAction without an audit sink still succeeds', async () => {
    const exit = await runCancelAction(
      'act-3',
      { json: true },
      {
        cancel: async () => undefined,
        streams: { stdout: () => undefined, stderr: () => undefined },
      },
    );
    expect(exit).toBe(0);
  });
});

describe('migrations status CLI', () => {
  function makeMigration(over: Partial<MigrationState> = {}): MigrationState {
    return {
      migration_id: ULID,
      source_platform: 'portainer',
      target_platform: 'k3s',
      classification: 'architectural',
      description: 'd',
      initiated_by: 'pwatson',
      initiated_at: '2026-05-01T10:00:00.000Z',
      approval_delay_seconds: 86_400,
      requires_typed_confirm: true,
      phases: [
        { name: 'identify-resources', status: 'complete' },
        { name: 'plan-target', status: 'complete' },
        { name: 'dry-run', status: 'complete' },
        {
          name: 'approval-delay',
          status: 'in-progress',
          started_at: '2026-05-01T10:00:00.000Z',
        },
        { name: 'execute', status: 'pending' },
      ],
      current_phase_index: 3,
      overall_status: 'in-flight',
      ...over,
    };
  }

  it('lists in-flight migrations with remaining_seconds in approval-delay', async () => {
    const m = makeMigration();
    const exit = await runMigrationsStatus(
      { json: true },
      {
        list: async () => [m],
        streams: {
          stdout: () => undefined,
          stderr: () => undefined,
        },
        // 1h after the started_at.
        now: () => Date.parse('2026-05-01T11:00:00.000Z'),
      },
    );
    expect(exit).toBe(0);
  });

  it('--id loads a specific migration; remaining_seconds = null outside approval-delay', async () => {
    const m = makeMigration({
      current_phase_index: 0,
      phases: [
        { name: 'identify-resources', status: 'in-progress' },
        { name: 'plan-target', status: 'pending' },
        { name: 'dry-run', status: 'pending' },
        { name: 'approval-delay', status: 'pending' },
        { name: 'execute', status: 'pending' },
      ],
    });
    const { captured, streams } = captureStreams();
    const handle = buildMigrationsCommand({
      load: async () => m,
      list: async () => [],
      streams,
      now: () => Date.parse('2026-05-01T10:00:00.000Z'),
    });
    await handle.command.parseAsync(['status', '--id', ULID, '--json'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { remaining_seconds: number | null }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.remaining_seconds).toBeNull();
  });

  it('renders text mode with phase + status', async () => {
    const m = makeMigration();
    const { captured, streams } = captureStreams();
    const handle = buildMigrationsCommand({
      list: async () => [m],
      streams,
      now: () => Date.parse('2026-05-01T11:00:00.000Z'),
    });
    await handle.command.parseAsync(['status'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toMatch(/portainer->k3s/);
    expect(captured.stdout).toMatch(/approval-delay/);
    expect(captured.stdout).toMatch(/remaining=/);
  });

  it('returns usage error when load throws', async () => {
    const { captured, streams } = captureStreams();
    const handle = buildMigrationsCommand({
      load: async () => {
        throw new Error('not found');
      },
      streams,
    });
    await handle.command.parseAsync(['status', '--id', ULID], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toMatch(/failed to read/);
  });
});
