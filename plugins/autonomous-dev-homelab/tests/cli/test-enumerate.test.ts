/**
 * Unit tests for `inventory enumerate` CLI command — issue #27.
 *
 * Tests the runEnumerate handler in isolation: mocks DeepEnumerator,
 * asserts on emitted output and exit codes.
 */

import { runEnumerate } from '../../src/cli/commands/enumerate';
import type { DeepEnumerator, DeepEnumerationResult } from '../../src/discovery/deep-enumerator';
import type { OutputStreams } from '../../src/cli/output';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../../src/cli/exit-codes';

function makeStreams(): { stdout: jest.Mock; stderr: jest.Mock; streams: OutputStreams } {
  const stdout = jest.fn();
  const stderr = jest.fn();
  return { stdout, stderr, streams: { stdout, stderr } };
}

function makeDeepEnumerator(result: DeepEnumerationResult): DeepEnumerator {
  return {
    enumerate: jest.fn().mockResolvedValue(result),
  } as unknown as DeepEnumerator;
}

describe('runEnumerate', () => {
  it('returns EXIT_USAGE and emits message when inventory is empty', async () => {
    const { streams, stdout } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({ summaries: [], totalEntities: 0, totalEdges: 0 });

    const code = await runEnumerate({}, { deepEnumerator, streams });

    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('no platforms'));
  });

  it('returns EXIT_OK when all platforms succeed', async () => {
    const { streams, stdout } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({
      summaries: [
        { platformId: 'swarm-01', platformKind: 'docker-swarm', ok: true, entitiesUpserted: 5, edgesUpserted: 4 },
      ],
      totalEntities: 5,
      totalEdges: 4,
    });

    const code = await runEnumerate({}, { deepEnumerator, streams });

    expect(code).toBe(EXIT_OK);
    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('5 entities');
    expect(allOut).toContain('4 edges');
  });

  it('returns EXIT_PARTIAL when some platforms fail', async () => {
    const { streams } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({
      summaries: [
        { platformId: 'swarm-ok', platformKind: 'docker-swarm', ok: true, entitiesUpserted: 3, edgesUpserted: 2 },
        { platformId: 'swarm-fail', platformKind: 'docker-swarm', ok: false, entitiesUpserted: 0, edgesUpserted: 0, error: 'conn refused' },
      ],
      totalEntities: 3,
      totalEdges: 2,
    });

    const code = await runEnumerate({}, { deepEnumerator, streams });

    expect(code).toBe(EXIT_PARTIAL);
  });

  it('returns EXIT_USAGE when all platforms fail', async () => {
    const { streams } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({
      summaries: [
        { platformId: 'swarm-fail', platformKind: 'docker-swarm', ok: false, entitiesUpserted: 0, edgesUpserted: 0, error: 'conn refused' },
      ],
      totalEntities: 0,
      totalEdges: 0,
    });

    const code = await runEnumerate({}, { deepEnumerator, streams });

    expect(code).toBe(EXIT_USAGE);
  });

  it('passes platform filter to deepEnumerator when --platform is set', async () => {
    const { streams } = makeStreams();
    const enumerateMock = jest.fn().mockResolvedValue({
      summaries: [
        { platformId: 'swarm-01', platformKind: 'docker-swarm', ok: true, entitiesUpserted: 2, edgesUpserted: 1 },
      ],
      totalEntities: 2,
      totalEdges: 1,
    });
    const deepEnumerator = { enumerate: enumerateMock } as unknown as DeepEnumerator;

    await runEnumerate({ platform: 'swarm-01' }, { deepEnumerator, streams });

    expect(enumerateMock).toHaveBeenCalledWith({ platformFilter: ['swarm-01'] });
  });

  it('emits JSON output when --json flag is set', async () => {
    const { streams, stdout } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({
      summaries: [
        { platformId: 'swarm-01', platformKind: 'docker-swarm', ok: true, entitiesUpserted: 5, edgesUpserted: 4 },
      ],
      totalEntities: 5,
      totalEdges: 4,
    });

    const code = await runEnumerate({ json: true }, { deepEnumerator, streams });

    expect(code).toBe(EXIT_OK);
    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toHaveProperty('total_entities', 5);
    expect(parsed).toHaveProperty('total_edges', 4);
    expect(Array.isArray(parsed.summaries)).toBe(true);
    expect(parsed.summaries[0]).toHaveProperty('platform_id', 'swarm-01');
    expect(parsed.summaries[0]).toHaveProperty('ok', true);
  });

  it('emits JSON with error field when a platform failed', async () => {
    const { streams, stdout } = makeStreams();
    const deepEnumerator = makeDeepEnumerator({
      summaries: [
        {
          platformId: 'swarm-fail',
          platformKind: 'docker-swarm',
          ok: false,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          error: 'connection refused',
        },
      ],
      totalEntities: 0,
      totalEdges: 0,
    });

    await runEnumerate({ json: true }, { deepEnumerator, streams });

    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed.summaries[0]).toHaveProperty('error', 'connection refused');
    expect(parsed.summaries[0]).toHaveProperty('ok', false);
  });

  it('returns EXIT_USAGE when deepEnumerator throws', async () => {
    const { streams } = makeStreams();
    const deepEnumerator = {
      enumerate: jest.fn().mockRejectedValue(new Error('boom')),
    } as unknown as DeepEnumerator;

    const code = await runEnumerate({}, { deepEnumerator, streams });

    expect(code).toBe(EXIT_USAGE);
  });
});
