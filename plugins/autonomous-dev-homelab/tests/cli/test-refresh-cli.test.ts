/**
 * Unit tests for `inventory refresh` CLI command — issue #31.
 *
 * Tests `runRefresh` in isolation: mocks RefreshEngine, asserts on
 * emitted output and exit codes. No disk or network access.
 */

import { runRefresh } from '../../src/cli/commands/refresh';
import type { RefreshEngine, SweepResult } from '../../src/discovery/refresh';
import type { OutputStreams } from '../../src/cli/output';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../../src/cli/exit-codes';

function makeStreams(): { stdout: jest.Mock; stderr: jest.Mock; streams: OutputStreams } {
  const stdout = jest.fn();
  const stderr = jest.fn();
  return { stdout, stderr, streams: { stdout, stderr } };
}

function makeSweepResult(overrides: Partial<SweepResult> = {}): SweepResult {
  return {
    sweepAt: '2026-06-01T00:00:00.000Z',
    entitiesUpserted: 0,
    edgesUpserted: 0,
    platformsFailed: 0,
    markedStale: 0,
    markedGone: 0,
    driftEvents: [],
    observationsEmitted: 0,
    ...overrides,
  };
}

function makeRefreshEngine(result: SweepResult): RefreshEngine {
  return {
    sweep: jest.fn().mockResolvedValue(result),
  } as unknown as RefreshEngine;
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('runRefresh: exit codes', () => {
  it('returns EXIT_OK when sweep succeeds with at least one entity upserted', async () => {
    const { streams } = makeStreams();
    const engine = makeRefreshEngine(makeSweepResult({ entitiesUpserted: 5 }));
    const code = await runRefresh({}, { refreshEngine: engine, streams });
    expect(code).toBe(EXIT_OK);
  });

  it('returns EXIT_OK when sweep succeeds with no entities (empty inventory)', async () => {
    const { streams } = makeStreams();
    const engine = makeRefreshEngine(makeSweepResult({ entitiesUpserted: 0, platformsFailed: 0 }));
    const code = await runRefresh({}, { refreshEngine: engine, streams });
    expect(code).toBe(EXIT_OK);
  });

  it('returns EXIT_PARTIAL when some platforms failed', async () => {
    const { streams } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({ entitiesUpserted: 3, platformsFailed: 1 }),
    );
    const code = await runRefresh({}, { refreshEngine: engine, streams });
    expect(code).toBe(EXIT_PARTIAL);
  });

  it('returns EXIT_USAGE when all platforms failed and no entities upserted', async () => {
    const { streams } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({ entitiesUpserted: 0, platformsFailed: 2 }),
    );
    const code = await runRefresh({}, { refreshEngine: engine, streams });
    expect(code).toBe(EXIT_USAGE);
  });

  it('returns EXIT_USAGE when engine.sweep() throws', async () => {
    const { streams } = makeStreams();
    const engine = {
      sweep: jest.fn().mockRejectedValue(new Error('sweep boom')),
    } as unknown as RefreshEngine;
    const code = await runRefresh({}, { refreshEngine: engine, streams });
    expect(code).toBe(EXIT_USAGE);
  });
});

// ---------------------------------------------------------------------------
// Platform filter forwarding
// ---------------------------------------------------------------------------

describe('runRefresh: platform filter', () => {
  it('forwards --platform filter to engine.sweep()', async () => {
    const { streams } = makeStreams();
    const sweepMock = jest.fn().mockResolvedValue(makeSweepResult({ entitiesUpserted: 2 }));
    const engine = { sweep: sweepMock } as unknown as RefreshEngine;

    await runRefresh({ platform: 'swarm-01' }, { refreshEngine: engine, streams });

    expect(sweepMock).toHaveBeenCalledWith({ platformFilter: ['swarm-01'] });
  });

  it('calls engine.sweep() with empty opts when no --platform', async () => {
    const { streams } = makeStreams();
    const sweepMock = jest.fn().mockResolvedValue(makeSweepResult());
    const engine = { sweep: sweepMock } as unknown as RefreshEngine;

    await runRefresh({}, { refreshEngine: engine, streams });

    expect(sweepMock).toHaveBeenCalledWith({});
  });
});

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

describe('runRefresh: human-readable output', () => {
  it('prints sweep summary to stdout', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        sweepAt: '2026-06-01T00:05:00.000Z',
        entitiesUpserted: 7,
        edgesUpserted: 4,
        markedStale: 1,
        markedGone: 0,
        driftEvents: [],
        observationsEmitted: 0,
      }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('2026-06-01T00:05:00.000Z');
    expect(allOut).toContain('7 entities');
    expect(allOut).toContain('4 edges');
    expect(allOut).toContain('1 stale');
  });

  it('prints WARNING to stderr when platforms failed', async () => {
    const { streams, stderr } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({ entitiesUpserted: 3, platformsFailed: 2 }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const errOut = stderr.mock.calls.map((c: string[]) => c[0]).join('');
    expect(errOut).toContain('WARNING');
    expect(errOut).toContain('2 platform');
  });

  it('prints ADDED drift event', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        entitiesUpserted: 1,
        driftEvents: [
          {
            kind: 'entity_added',
            entity: {
              id: 'svc-new',
              kind: 'service',
              name: 'my-service',
              attributes: {},
              source: 'test',
              platformId: 'p1',
              discovered_at: '2026-06-01T00:00:00.000Z',
              last_seen: '2026-06-01T00:00:00.000Z',
              status: 'active',
            },
          },
        ],
      }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('ADDED');
    expect(allOut).toContain('my-service');
  });

  it('prints GONE drift event', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        entitiesUpserted: 0,
        driftEvents: [
          {
            kind: 'entity_gone',
            entity: {
              id: 'svc-gone',
              kind: 'service',
              name: 'gone-svc',
              attributes: {},
              source: 'test',
              platformId: 'p1',
              discovered_at: '2026-06-01T00:00:00.000Z',
              last_seen: '2026-06-01T00:00:00.000Z',
              status: 'gone',
            },
          },
        ],
      }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('GONE');
    expect(allOut).toContain('gone-svc');
  });

  it('prints REPLICAS drift event with running/desired counts', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        entitiesUpserted: 1,
        driftEvents: [
          {
            kind: 'replica_mismatch',
            entity: {
              id: 'svc-r',
              kind: 'service',
              name: 'replica-svc',
              attributes: { replicas_running: 1, replicas_desired: 3 },
              source: 'test',
              platformId: 'p1',
              discovered_at: '2026-06-01T00:00:00.000Z',
              last_seen: '2026-06-01T00:00:00.000Z',
              status: 'active',
            },
            replicasRunning: 1,
            replicasDesired: 3,
          },
        ],
      }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('REPLICAS');
    expect(allOut).toContain('1/3');
  });

  it('prints IMAGE drift event with previous → current image', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        entitiesUpserted: 1,
        driftEvents: [
          {
            kind: 'image_changed',
            entity: {
              id: 'svc-img',
              kind: 'service',
              name: 'img-svc',
              attributes: { image: 'nginx:1.25' },
              source: 'test',
              platformId: 'p1',
              discovered_at: '2026-06-01T00:00:00.000Z',
              last_seen: '2026-06-01T00:00:00.000Z',
              status: 'active',
            },
            previousImage: 'nginx:1.24',
            currentImage: 'nginx:1.25',
          },
        ],
      }),
    );
    await runRefresh({}, { refreshEngine: engine, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('IMAGE');
    expect(allOut).toContain('nginx:1.24');
    expect(allOut).toContain('nginx:1.25');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('runRefresh: JSON output', () => {
  it('emits valid JSON with all summary fields when --json is set', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        sweepAt: '2026-06-01T00:00:00.000Z',
        entitiesUpserted: 4,
        edgesUpserted: 2,
        platformsFailed: 0,
        markedStale: 1,
        markedGone: 1,
        driftEvents: [],
        observationsEmitted: 1,
      }),
    );

    const code = await runRefresh({ json: true }, { refreshEngine: engine, streams });

    expect(code).toBe(EXIT_OK);
    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toHaveProperty('sweep_at', '2026-06-01T00:00:00.000Z');
    expect(parsed).toHaveProperty('entities_upserted', 4);
    expect(parsed).toHaveProperty('edges_upserted', 2);
    expect(parsed).toHaveProperty('platforms_failed', 0);
    expect(parsed).toHaveProperty('marked_stale', 1);
    expect(parsed).toHaveProperty('marked_gone', 1);
    expect(parsed).toHaveProperty('observations_emitted', 1);
    expect(parsed).toHaveProperty('drift');
    expect(Array.isArray(parsed.drift)).toBe(true);
  });

  it('includes drift event details in JSON output', async () => {
    const { streams, stdout } = makeStreams();
    const engine = makeRefreshEngine(
      makeSweepResult({
        entitiesUpserted: 1,
        driftEvents: [
          {
            kind: 'replica_mismatch',
            entity: {
              id: 'svc-r',
              kind: 'service',
              name: 'r-svc',
              attributes: {},
              source: 'test',
              platformId: 'p1',
              discovered_at: '2026-06-01T00:00:00.000Z',
              last_seen: '2026-06-01T00:00:00.000Z',
              status: 'active',
            },
            replicasRunning: 0,
            replicasDesired: 2,
          },
        ],
      }),
    );

    await runRefresh({ json: true }, { refreshEngine: engine, streams });

    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed.drift).toHaveLength(1);
    expect(parsed.drift[0]).toMatchObject({
      kind: 'replica_mismatch',
      entity_id: 'svc-r',
      replicas_running: 0,
      replicas_desired: 2,
    });
  });
});
