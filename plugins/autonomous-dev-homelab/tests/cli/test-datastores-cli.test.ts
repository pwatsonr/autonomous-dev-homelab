/**
 * Unit tests for `inventory datastores` CLI command (issue #42).
 *
 * Tests the runDatastores handler in isolation: mocks DatastoreProbe,
 * asserts on emitted output and exit codes.
 *
 * Invariant #62: entity names in fixtures are generic; no homelab-specific
 * instance names in assertions (only structural checks).
 */

import { runDatastores } from '../../src/cli/commands/datastores';
import type { DatastoreProbe, DatastoreProbeResult } from '../../src/discovery/datastore-probe';
import type { OutputStreams } from '../../src/cli/output';
import { EXIT_OK, EXIT_USAGE } from '../../src/cli/exit-codes';

const NOW = '2026-06-23T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreams(): { stdout: jest.Mock; stderr: jest.Mock; streams: OutputStreams } {
  const stdout = jest.fn();
  const stderr = jest.fn();
  return { stdout, stderr, streams: { stdout, stderr } };
}

function makeProbe(result: DatastoreProbeResult): DatastoreProbe {
  return {
    probe: jest.fn().mockResolvedValue(result),
  } as unknown as DatastoreProbe;
}

function emptyResult(): DatastoreProbeResult {
  return { discovered: 0, introspected: 0, skipped: 0, results: [] };
}

function singleDatastoreResult(engine: string, health: string, dbCount: number): DatastoreProbeResult {
  const datastoreEntity = {
    id: `datastore:plat:my-${engine}`,
    kind: 'datastore' as const,
    name: `my-${engine}`,
    attributes: { engine, version: '16.1', health },
    source: 'datastore-probe',
    platformId: 'plat',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active' as const,
  };
  const children = Array.from({ length: dbCount }, (_, i) => ({
    id: `database:datastore:plat:my-${engine}:db${i}`,
    kind: 'database' as const,
    name: `db${i}`,
    attributes: { size_bytes: 1024 * (i + 1), count: 100 * (i + 1) },
    source: 'datastore-probe',
    platformId: 'plat',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active' as const,
  }));
  return {
    discovered: 1,
    introspected: health !== 'unknown' ? 1 : 0,
    skipped: health === 'unknown' ? 1 : 0,
    results: [{ datastoreEntity, children, edges: [] }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDatastores', () => {
  describe('empty result', () => {
    test('returns EXIT_USAGE with helpful message when nothing found', async () => {
      const { streams, stdout } = makeStreams();
      const code = await runDatastores({}, { datastoreProbe: makeProbe(emptyResult()), streams });
      expect(code).toBe(EXIT_USAGE);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('no datastore entities found'));
    });

    test('--json emits empty array object and returns EXIT_USAGE', async () => {
      const { streams, stdout } = makeStreams();
      const code = await runDatastores({ json: true }, { datastoreProbe: makeProbe(emptyResult()), streams });
      expect(code).toBe(EXIT_USAGE);
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      const parsed = JSON.parse(out) as { discovered: number; datastores: unknown[] };
      expect(parsed.discovered).toBe(0);
      expect(parsed.datastores).toHaveLength(0);
    });
  });

  describe('single datastore — human-readable output', () => {
    test('prints engine, version, health, database count', async () => {
      const { streams, stdout } = makeStreams();
      const code = await runDatastores(
        {},
        { datastoreProbe: makeProbe(singleDatastoreResult('postgres', 'ok', 2)), streams },
      );
      expect(code).toBe(EXIT_OK);
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      expect(out).toContain('engine=postgres');
      expect(out).toContain('version=16.1');
      expect(out).toContain('health=ok');
      expect(out).toContain('databases=2');
      // database list lines
      expect(out).toContain('db0');
      expect(out).toContain('db1');
    });

    test('prints summary line with total counts', async () => {
      const { streams, stdout } = makeStreams();
      await runDatastores(
        {},
        { datastoreProbe: makeProbe(singleDatastoreResult('redis', 'ok', 1)), streams },
      );
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      expect(out).toContain('1 discovered');
      expect(out).toContain('1 introspected');
    });

    test('health=unknown does not crash; skipped count reflected in summary', async () => {
      const { streams, stdout } = makeStreams();
      const code = await runDatastores(
        {},
        { datastoreProbe: makeProbe(singleDatastoreResult('redis', 'unknown', 0)), streams },
      );
      expect(code).toBe(EXIT_OK);
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      expect(out).toContain('health=unknown');
      expect(out).toContain('1 skipped');
    });
  });

  describe('single datastore — JSON output', () => {
    test('--json emits valid JSON with datastore details', async () => {
      const { streams, stdout } = makeStreams();
      await runDatastores(
        { json: true },
        { datastoreProbe: makeProbe(singleDatastoreResult('postgres', 'ok', 2)), streams },
      );
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      const parsed = JSON.parse(out) as {
        discovered: number;
        introspected: number;
        skipped: number;
        datastores: Array<{ engine: string; health: string; databases: unknown[] }>;
      };
      expect(parsed.discovered).toBe(1);
      expect(parsed.introspected).toBe(1);
      expect(parsed.datastores).toHaveLength(1);
      expect(parsed.datastores[0]!.engine).toBe('postgres');
      expect(parsed.datastores[0]!.health).toBe('ok');
      expect(parsed.datastores[0]!.databases).toHaveLength(2);
    });

    test('JSON output never contains user-data fields', async () => {
      const { streams, stdout } = makeStreams();
      await runDatastores(
        { json: true },
        { datastoreProbe: makeProbe(singleDatastoreResult('postgres', 'ok', 1)), streams },
      );
      const out = stdout.mock.calls.map((c: string[]) => c[0]).join('');
      // Ensure no value-revealing fields appear
      expect(out).not.toContain('row_values');
      expect(out).not.toContain('key_values');
      expect(out).not.toContain('document');
    });
  });

  describe('error handling', () => {
    test('probe.probe() throws → EXIT_USAGE with error on stderr', async () => {
      const { streams, stderr } = makeStreams();
      const failingProbe = {
        probe: jest.fn().mockRejectedValue(new Error('disk read failed')),
      } as unknown as DatastoreProbe;
      const code = await runDatastores({}, { datastoreProbe: failingProbe, streams });
      expect(code).toBe(EXIT_USAGE);
      const errOut = stderr.mock.calls.map((c: string[]) => c[0]).join('');
      expect(errOut).toContain('ERROR:');
      expect(errOut).toContain('disk read failed');
    });
  });
});
