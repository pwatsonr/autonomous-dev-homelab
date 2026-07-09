/**
 * Unit tests for the `inventory topology` CLI command handler (issue #29).
 *
 * Tests:
 * - EXIT_OK when all passes succeed
 * - EXIT_PARTIAL when some passes fail with errors
 * - JSON output structure
 * - Human-readable output lines
 * - Degraded passes still produce EXIT_OK (degraded ≠ failed)
 * - EXIT_USAGE when TopologyEnricher throws
 *
 * All dependencies are mocked.
 */

import { runTopology } from '../../src/cli/commands/topology';
import type { TopologyEnricher, TopologyEnrichmentResult } from '../../src/discovery/topology/index';
import type { OutputStreams } from '../../src/cli/output';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../../src/cli/exit-codes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreams(): { stdout: jest.Mock; stderr: jest.Mock; streams: OutputStreams } {
  const stdout = jest.fn();
  const stderr = jest.fn();
  return { stdout, stderr, streams: { stdout, stderr } };
}

function makeEnricher(result: TopologyEnrichmentResult): TopologyEnricher {
  return {
    enrich: jest.fn().mockResolvedValue(result),
  } as unknown as TopologyEnricher;
}

function makeResult(overrides: Partial<TopologyEnrichmentResult> = {}): TopologyEnrichmentResult {
  return {
    npm: { ok: true, entitiesUpserted: 3, edgesUpserted: 5, degraded: false },
    vault: { ok: true, entitiesUpserted: 10, edgesUpserted: 10, degraded: false },
    deps: { ok: true, entitiesUpserted: 0, edgesUpserted: 7 },
    totalEntitiesUpserted: 13,
    totalEdgesUpserted: 22,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTopology', () => {
  it('returns EXIT_OK when all passes succeed', async () => {
    const { streams } = makeStreams();
    const enricher = makeEnricher(makeResult());
    const code = await runTopology({}, { topologyEnricher: enricher, streams });
    expect(code).toBe(EXIT_OK);
  });

  it('returns EXIT_PARTIAL when any pass has ok=false', async () => {
    const { streams } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        npm: { ok: false, entitiesUpserted: 0, edgesUpserted: 0, error: 'timeout' },
        totalEntitiesUpserted: 10,
        totalEdgesUpserted: 17,
      }),
    );
    const code = await runTopology({}, { topologyEnricher: enricher, streams });
    expect(code).toBe(EXIT_PARTIAL);
  });

  it('returns EXIT_USAGE when TopologyEnricher throws', async () => {
    const { streams } = makeStreams();
    const enricher = {
      enrich: jest.fn().mockRejectedValue(new Error('fatal error')),
    } as unknown as TopologyEnricher;
    const code = await runTopology({}, { topologyEnricher: enricher, streams });
    expect(code).toBe(EXIT_USAGE);
  });

  it('returns EXIT_OK when npm is degraded but not failed', async () => {
    const { streams } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        npm: {
          ok: true,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          degraded: true,
          degradeReason: 'NPM_API_TOKEN not set',
        },
      }),
    );
    const code = await runTopology({}, { topologyEnricher: enricher, streams });
    expect(code).toBe(EXIT_OK);
  });

  it('emits JSON output when --json flag is set', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(makeResult());
    await runTopology({ json: true }, { topologyEnricher: enricher, streams });

    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toHaveProperty('total_entities_upserted', 13);
    expect(parsed).toHaveProperty('total_edges_upserted', 22);
    expect(parsed).toHaveProperty('npm');
    expect(parsed).toHaveProperty('vault');
    expect(parsed).toHaveProperty('deps');
    expect(parsed.npm).toHaveProperty('ok', true);
    expect(parsed.npm).toHaveProperty('entities_upserted', 3);
    expect(parsed.npm).toHaveProperty('edges_upserted', 5);
    expect(parsed.npm).toHaveProperty('degraded', false);
  });

  it('JSON output includes degrade_reason when npm is degraded', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        npm: {
          ok: true,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          degraded: true,
          degradeReason: 'NPM_API_TOKEN not set',
        },
      }),
    );
    await runTopology({ json: true }, { topologyEnricher: enricher, streams });

    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed.npm).toHaveProperty('degraded', true);
    expect(parsed.npm).toHaveProperty('degrade_reason', 'NPM_API_TOKEN not set');
  });

  it('JSON output includes error field when a pass failed', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        vault: {
          ok: false,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          degraded: false,
          error: 'connection refused',
        },
        totalEntitiesUpserted: 3,
        totalEdgesUpserted: 12,
      }),
    );
    await runTopology({ json: true }, { topologyEnricher: enricher, streams });

    const rawOutput = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    const parsed = JSON.parse(rawOutput);
    expect(parsed.vault).toHaveProperty('ok', false);
    expect(parsed.vault).toHaveProperty('error', 'connection refused');
  });

  it('human-readable output includes all three pass names', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(makeResult());
    await runTopology({}, { topologyEnricher: enricher, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('npm');
    expect(allOut).toContain('vault');
    expect(allOut).toContain('deps');
  });

  it('human-readable output includes total counts', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(makeResult());
    await runTopology({}, { topologyEnricher: enricher, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('13');
    expect(allOut).toContain('22');
  });

  it('human-readable output mentions FAILED for failed passes', async () => {
    const { streams, stderr } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        npm: {
          ok: false,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          error: 'connection timeout',
        },
        totalEntitiesUpserted: 10,
        totalEdgesUpserted: 17,
      }),
    );
    await runTopology({}, { topologyEnricher: enricher, streams });

    const allErr = stderr.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allErr).toContain('connection timeout');
  });

  it('human-readable output mentions degraded reason for degraded passes', async () => {
    const { streams, stdout } = makeStreams();
    const enricher = makeEnricher(
      makeResult({
        npm: {
          ok: true,
          entitiesUpserted: 0,
          edgesUpserted: 0,
          degraded: true,
          degradeReason: 'NPM_API_TOKEN not set',
        },
      }),
    );
    await runTopology({}, { topologyEnricher: enricher, streams });

    const allOut = stdout.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allOut).toContain('NPM_API_TOKEN not set');
  });
});
