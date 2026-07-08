/**
 * Unit tests for CapacityProbe (issue #44, invariant #62).
 *
 * Test matrix:
 *   - parseDfLine / parseZpoolListLine — parser correctness
 *   - dfMountPath                      — mount-path derivation
 *   - readCapacityFromAttributes       — attribute fallback priority
 *   - CapacityProbe.scan()
 *       - single entity below threshold → no observation
 *       - entity at warn threshold → capacity_warning P1
 *       - entity at critical threshold → capacity_critical P0
 *       - growth detection with two samples → capacity_growth P1
 *       - critical subsumes warn (only one observation per target)
 *       - graceful degradation: entity without capacity attrs → skipped
 *       - graceful degradation: exec throws → falls back to attributes
 *       - live df probing for filesystem kinds (storage-array, share, storage-disk)
 *       - live zpool list for pool kind
 *       - datastore entity uses attribute fallback (no exec command)
 *       - multiple entities — independent observations per entity
 *       - configurable thresholds
 *
 * All graph and exec calls are mocked — no live connections.
 * Invariant #62: no homelab-specific instance names in test data.
 */

import * as path from 'node:path';
import {
  CapacityProbe,
  parseDfLine,
  parseZpoolListLine,
  dfMountPath,
  readCapacityFromAttributes,
  type CapacityExecSource,
  type CapacitySample,
} from '../../../src/observation/probes/capacity';
import { GraphStore } from '../../../src/discovery/graph-store';
import type { Entity } from '../../../src/discovery/graph-types';
import { fileMutex } from '../../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM = 'test-nas-01';
const NOW_ISO = '2026-06-23T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(
  kind: string,
  name: string,
  attrs: Record<string, unknown> = {},
): Entity {
  return {
    id: `${kind}:${PLATFORM}:${name}`,
    kind,
    name,
    attributes: attrs,
    source: 'test',
    platformId: PLATFORM,
    discovered_at: NOW_ISO,
    last_seen: NOW_ISO,
    status: 'active',
  };
}

function makeExecSource(
  responses: Record<string, { stdout: string; exitCode?: number }>,
): CapacityExecSource {
  return {
    platformId: PLATFORM,
    exec: jest.fn().mockImplementation(async (cmd: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (cmd.includes(key)) return value;
      }
      return { stdout: '', exitCode: 1 };
    }),
  };
}

// df -PB1 output: header + one data line (filesystem, 1B-blocks, used, avail, use%, mount)
function dfOutput(totalBytes: number, usedBytes: number): string {
  const avail = totalBytes - usedBytes;
  const usePct = Math.round((usedBytes / totalBytes) * 100);
  return [
    'Filesystem       1B-blocks        Used   Available Use% Mounted on',
    `/dev/sda1 ${totalBytes} ${usedBytes} ${avail} ${usePct}% /mnt/user`,
  ].join('\n');
}

// zpool list -Hp output: one tab-delimited line (name, size, alloc, free, ...)
function zpoolListOutput(totalBytes: number, usedBytes: number): string {
  const freeBytes = totalBytes - usedBytes;
  return `tank\t${totalBytes}\t${usedBytes}\t${freeBytes}\t-\t-\t0%\t${Math.round((usedBytes / totalBytes) * 100)}%\t1.00x\tONLINE\t-`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('test-capacity-probe-');
  const graphPath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphPath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// parseDfLine
// ---------------------------------------------------------------------------

describe('parseDfLine', () => {
  test('parses a standard df -PB1 data line', () => {
    const line = '/dev/sda1 1000000000 800000000 200000000 80% /mnt/user';
    const result = parseDfLine(line);
    expect(result).toEqual({ used: 800_000_000, total: 1_000_000_000 });
  });

  test('returns null for header line (insufficient columns)', () => {
    expect(parseDfLine('Filesystem 1B-blocks Used')).toBeNull();
  });

  test('returns null when total is zero', () => {
    expect(parseDfLine('/dev/sda1 0 0 0 0% /mnt/x')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseDfLine('')).toBeNull();
  });

  test('handles leading whitespace', () => {
    const line = '  /dev/sda1 500000000 400000000 100000000 80% /mnt/disk1';
    const result = parseDfLine(line);
    expect(result).toEqual({ used: 400_000_000, total: 500_000_000 });
  });
});

// ---------------------------------------------------------------------------
// parseZpoolListLine
// ---------------------------------------------------------------------------

describe('parseZpoolListLine', () => {
  test('parses a tab-delimited zpool list -Hp line', () => {
    const line = 'tank\t10737418240\t8589934592\t2147483648\t-\t-\t0%\t80%\t1.00x\tONLINE\t-';
    const result = parseZpoolListLine(line);
    expect(result).toEqual({ used: 8_589_934_592, total: 10_737_418_240 });
  });

  test('parses a space-delimited line', () => {
    const line = 'tank 10737418240 8589934592 2147483648 - - 0% 80% 1.00x ONLINE -';
    const result = parseZpoolListLine(line);
    expect(result).toEqual({ used: 8_589_934_592, total: 10_737_418_240 });
  });

  test('returns null for insufficient columns', () => {
    expect(parseZpoolListLine('tank')).toBeNull();
    expect(parseZpoolListLine('')).toBeNull();
  });

  test('returns null when total is zero', () => {
    expect(parseZpoolListLine('tank\t0\t0\tfree')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dfMountPath
// ---------------------------------------------------------------------------

describe('dfMountPath', () => {
  test('share → /mnt/<name>', () => {
    const e = makeEntity('share', 'media');
    expect(dfMountPath(e)).toBe('/mnt/media');
  });

  test('storage-array → /mnt/user', () => {
    const e = makeEntity('storage-array', 'my-array');
    expect(dfMountPath(e)).toBe('/mnt/user');
  });

  test('storage-disk uses slot attribute when available', () => {
    const e = makeEntity('storage-disk', 'disk1', { slot: 'disk1' });
    expect(dfMountPath(e)).toBe('/mnt/disk1');
  });

  test('storage-disk falls back to entity name when no slot attr', () => {
    const e = makeEntity('storage-disk', 'cache');
    expect(dfMountPath(e)).toBe('/mnt/cache');
  });

  test('datastore → null (no filesystem mount)', () => {
    const e = makeEntity('datastore', 'my-db');
    expect(dfMountPath(e)).toBeNull();
  });

  test('pool → null (uses zpool list instead of df)', () => {
    const e = makeEntity('pool', 'tank');
    expect(dfMountPath(e)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCapacityFromAttributes
// ---------------------------------------------------------------------------

describe('readCapacityFromAttributes', () => {
  test('reads used_bytes / size_bytes attributes', () => {
    const e = makeEntity('storage-disk', 'disk1', { used_bytes: 400, size_bytes: 500 });
    expect(readCapacityFromAttributes(e)).toEqual({ used: 400, total: 500 });
  });

  test('reads disk_used_bytes / disk_limit_bytes attributes', () => {
    const e = makeEntity('datastore', 'pg', { disk_used_bytes: 300, disk_limit_bytes: 1000 });
    expect(readCapacityFromAttributes(e)).toEqual({ used: 300, total: 1000 });
  });

  test('reads plain used / size attributes', () => {
    const e = makeEntity('pool', 'tank', { used: 200, size: 800 });
    expect(readCapacityFromAttributes(e)).toEqual({ used: 200, total: 800 });
  });

  test('reads string-valued attributes (parses to int)', () => {
    const e = makeEntity('storage-disk', 'd2', { used_bytes: '1000', size_bytes: '2000' });
    expect(readCapacityFromAttributes(e)).toEqual({ used: 1000, total: 2000 });
  });

  test('returns null when no capacity attributes present', () => {
    const e = makeEntity('share', 'backups');
    expect(readCapacityFromAttributes(e)).toBeNull();
  });

  test('returns null when total is zero', () => {
    const e = makeEntity('storage-disk', 'd3', { used_bytes: 0, size_bytes: 0 });
    expect(readCapacityFromAttributes(e)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — core behaviour
// ---------------------------------------------------------------------------

describe('CapacityProbe.scan() — no capacity data', () => {
  test('returns [] when graph is empty', async () => {
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });

  test('returns [] when entity has no capacity attributes', async () => {
    await graphStore.upsertEntity(makeEntity('datastore', 'my-db'));
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });
});

describe('CapacityProbe.scan() — threshold observations', () => {
  test('below warn threshold → no observation', async () => {
    // 70 % fill → below default 80 % warn
    await graphStore.upsertEntity(
      makeEntity('datastore', 'pg', { disk_used_bytes: 700, disk_limit_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });

  test('at warn threshold (80 %) → capacity_warning P1', async () => {
    await graphStore.upsertEntity(
      makeEntity('datastore', 'pg', { disk_used_bytes: 800, disk_limit_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
    expect(obs[0]!.severity).toBe('P1');
    expect(obs[0]!.resource).toBe('datastore/pg');
    expect(obs[0]!.platform).toBe(PLATFORM);
    expect(obs[0]!.details!['used_pct']).toBe(80);
    expect(obs[0]!.details!['used_bytes']).toBe(800);
    expect(obs[0]!.details!['total_bytes']).toBe(1000);
  });

  test('at critical threshold (90 %) → capacity_critical P0', async () => {
    await graphStore.upsertEntity(
      makeEntity('share', 'media', { used_bytes: 900, size_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
    expect(obs[0]!.severity).toBe('P0');
    expect(obs[0]!.resource).toBe('share/media');
    expect(obs[0]!.details!['used_pct']).toBe(90);
  });

  test('critical (≥90 %) subsumes warn — only one observation emitted', async () => {
    // 95 % fill — exceeds both critical (90 %) and warn (80 %)
    await graphStore.upsertEntity(
      makeEntity('share', 'data', { used_bytes: 950, size_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    // Only capacity_critical should be emitted, not also capacity_warning
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
  });

  test('configurable warn threshold (85 %)', async () => {
    // 82 % fill — below default 80 % is NOT below the custom 85 % threshold
    await graphStore.upsertEntity(
      makeEntity('datastore', 'db', { disk_used_bytes: 82, disk_limit_bytes: 100 }),
    );
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      warnThreshold: 0.85,
    });
    // 82 % is below custom 85 % → no observation
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });

  test('configurable critical threshold (95 %)', async () => {
    // 91 % fill — above default 90 % critical but below custom 95 %
    await graphStore.upsertEntity(
      makeEntity('share', 'backup', { used_bytes: 91, size_bytes: 100 }),
    );
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      warnThreshold: 0.80,
      criticalThreshold: 0.95,
    });
    // 91 % → above warn (80 %) but below custom critical (95 %) → capacity_warning
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — growth detection
// ---------------------------------------------------------------------------

describe('CapacityProbe.scan() — growth detection', () => {
  test('growth within window emits capacity_growth when below warn', async () => {
    // Entity at 70 % fill (below 80 % warn) but growing fast
    const entityId = `datastore:${PLATFORM}:growing-db`;
    await graphStore.upsertEntity(
      makeEntity('datastore', 'growing-db', { disk_used_bytes: 700, disk_limit_bytes: 1000 }),
    );

    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      growthWindowSeconds: 7 * 24 * 3600, // 7 days
    });

    // First scan — establishes baseline sample (no previous → no growth obs)
    const obs1 = await probe.scan();
    expect(obs1).toEqual([]);

    // Simulate 1 hour later: entity has grown 50 bytes → ~1.2 TB/day fill rate
    // (this means at 300 free bytes + 50 bytes/hour rate → ~6 hours to full)
    await graphStore.upsertEntity(
      makeEntity('datastore', 'growing-db', { disk_used_bytes: 750, disk_limit_bytes: 1000 }),
    );

    // Inject an earlier sample so the probe sees a time delta
    const snapshot = probe.getSampleSnapshot();
    const baseSample: CapacitySample = {
      usedBytes: 700,
      totalBytes: 1000,
      sampledAt: Date.now() - 3600 * 1000, // 1 hour ago
    };
    snapshot.set(entityId, baseSample);
    // Patch the internal sample map via the test seam
    const internalMap = (probe as unknown as { lastSamples: Map<string, CapacitySample> }).lastSamples;
    internalMap.set(entityId, baseSample);

    const obs2 = await probe.scan();
    // 750 used; 250 free; rate ≈ 50 bytes / 3600 s ≈ 0.0139 B/s
    // secondsToFull ≈ 250 / 0.0139 ≈ 18 000 s ≈ 0.2 days — within 7 day window
    expect(obs2.some((o) => o.pattern === 'capacity_growth')).toBe(true);
    const growthObs = obs2.find((o) => o.pattern === 'capacity_growth')!;
    expect(growthObs.severity).toBe('P1');
    expect(growthObs.resource).toBe('datastore/growing-db');
    expect(growthObs.details!['fill_rate_bytes_per_second']).toBeGreaterThan(0);
    expect(growthObs.details!['days_to_full']).toBeGreaterThanOrEqual(0);
  });

  test('growth outside window does NOT emit capacity_growth', async () => {
    const entityId = `datastore:${PLATFORM}:slow-db`;
    await graphStore.upsertEntity(
      makeEntity('datastore', 'slow-db', { disk_used_bytes: 700, disk_limit_bytes: 1000 }),
    );

    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      growthWindowSeconds: 24 * 3600, // 1 day window
    });

    // Plant a previous sample showing very slow growth
    const internalMap = (probe as unknown as { lastSamples: Map<string, CapacitySample> }).lastSamples;
    // Rate: 1 byte in 3600 s = 0.000278 B/s; freeBytes=300; secondsToFull≈1 080 000 s≈12.5 days
    // 12.5 days > 1 day window → no growth obs
    internalMap.set(entityId, {
      usedBytes: 699,
      totalBytes: 1000,
      sampledAt: Date.now() - 3600 * 1000,
    });

    const obs = await probe.scan();
    expect(obs.every((o) => o.pattern !== 'capacity_growth')).toBe(true);
  });

  test('first scan does not emit capacity_growth (no prior sample)', async () => {
    await graphStore.upsertEntity(
      makeEntity('datastore', 'fresh-db', { disk_used_bytes: 500, disk_limit_bytes: 1000 }),
    );

    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    // 50 % fill, no prior sample → no observations
    expect(obs).toEqual([]);
  });

  test('negative growth rate (freeing space) does NOT emit capacity_growth', async () => {
    const entityId = `datastore:${PLATFORM}:shrinking-db`;
    await graphStore.upsertEntity(
      makeEntity('datastore', 'shrinking-db', { disk_used_bytes: 600, disk_limit_bytes: 1000 }),
    );

    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const internalMap = (probe as unknown as { lastSamples: Map<string, CapacitySample> }).lastSamples;
    // Previous sample had MORE used bytes → negative delta → no growth
    internalMap.set(entityId, {
      usedBytes: 700,
      totalBytes: 1000,
      sampledAt: Date.now() - 3600 * 1000,
    });

    const obs = await probe.scan();
    expect(obs.every((o) => o.pattern !== 'capacity_growth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — live exec sources
// ---------------------------------------------------------------------------

describe('CapacityProbe.scan() — live df probing', () => {
  test('share entity uses df -PB1 /mnt/<name> when execSource is provided', async () => {
    // 85 % fill via live df → capacity_warning
    const execSrc = makeExecSource({
      '/mnt/media': { stdout: dfOutput(1000, 850), exitCode: 0 },
    });

    await graphStore.upsertEntity(makeEntity('share', 'media'));
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
    expect(obs[0]!.resource).toBe('share/media');
    expect((execSrc.exec as jest.Mock).mock.calls.some((c: string[]) =>
      c[0].includes('df -PB1 /mnt/media'),
    )).toBe(true);
  });

  test('storage-array uses df -PB1 /mnt/user', async () => {
    const execSrc = makeExecSource({
      '/mnt/user': { stdout: dfOutput(10_000_000_000, 9_500_000_000), exitCode: 0 },
    });

    await graphStore.upsertEntity(makeEntity('storage-array', 'main-array'));
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
    expect(obs[0]!.resource).toBe('storage-array/main-array');
  });

  test('storage-disk uses df -PB1 /mnt/<slot>', async () => {
    const execSrc = makeExecSource({
      '/mnt/disk1': { stdout: dfOutput(1_000_000, 810_000), exitCode: 0 },
    });

    await graphStore.upsertEntity(makeEntity('storage-disk', 'disk1', { slot: 'disk1' }));
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
  });

  test('df exec failure falls back to graph attributes', async () => {
    // exec always fails (exit code 1), but entity has attributes
    const execSrc = makeExecSource({});
    await graphStore.upsertEntity(
      makeEntity('share', 'docs', { used_bytes: 900, size_bytes: 1000 }),
    );
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    const obs = await probe.scan();

    // Fallback to 90 % attributes → capacity_critical
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
  });

  test('exec throws (network error) falls back to attributes', async () => {
    const throwingExec: CapacityExecSource = {
      platformId: PLATFORM,
      exec: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    await graphStore.upsertEntity(
      makeEntity('share', 'vault', { used_bytes: 820, size_bytes: 1000 }),
    );
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: throwingExec,
    });
    const obs = await probe.scan();

    // 82 % → capacity_warning from attribute fallback
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
  });
});

describe('CapacityProbe.scan() — ZFS pool probing', () => {
  test('pool entity uses zpool list -Hp <name>', async () => {
    // 80 % full ZFS pool
    const execSrc = makeExecSource({
      'zpool list -Hp tank': { stdout: zpoolListOutput(10_000_000_000, 8_000_000_000), exitCode: 0 },
    });

    await graphStore.upsertEntity(makeEntity('pool', 'tank'));
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
    expect(obs[0]!.resource).toBe('pool/tank');
    expect((execSrc.exec as jest.Mock).mock.calls.some((c: string[]) =>
      c[0].includes('zpool list -Hp tank'),
    )).toBe(true);
  });

  test('pool without exec source falls back to attributes', async () => {
    await graphStore.upsertEntity(
      makeEntity('pool', 'data', { used: 900, size: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
  });
});

describe('CapacityProbe.scan() — datastore kind uses attribute fallback', () => {
  test('datastore entity uses disk_used_bytes / disk_limit_bytes attributes', async () => {
    // Simulate what DatastoreProbe sets after discovery
    await graphStore.upsertEntity(
      makeEntity('datastore', 'my-pg', {
        engine: 'postgres',
        disk_used_bytes: 850,
        disk_limit_bytes: 1000,
      }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_warning');
    expect(obs[0]!.resource).toBe('datastore/my-pg');
    expect(obs[0]!.details!['kind']).toBe('datastore');
  });

  test('datastore does NOT issue df commands (no filesystem mount for databases)', async () => {
    const execSpy = jest.fn().mockResolvedValue({ stdout: '', exitCode: 1 });
    const execSrc: CapacityExecSource = { platformId: PLATFORM, exec: execSpy };

    await graphStore.upsertEntity(
      makeEntity('datastore', 'cache-db', { disk_used_bytes: 400, disk_limit_bytes: 1000 }),
    );
    const probe = new CapacityProbe({
      platformId: PLATFORM,
      graphStore,
      execSource: execSrc,
    });
    await probe.scan();

    // No df or zpool commands should have been issued for a datastore
    const dfCalls = execSpy.mock.calls.filter((c: string[]) => c[0].includes('df -PB1'));
    const zpoolCalls = execSpy.mock.calls.filter((c: string[]) => c[0].includes('zpool'));
    expect(dfCalls).toHaveLength(0);
    expect(zpoolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — graceful degradation
// ---------------------------------------------------------------------------

describe('CapacityProbe.scan() — graceful degradation', () => {
  test('entity with no capacity data is skipped silently', async () => {
    await graphStore.upsertEntity(makeEntity('storage-disk', 'parity'));
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });

  test('mix of entities: one has data, one does not — only first emits obs', async () => {
    await graphStore.upsertEntity(
      makeEntity('share', 'movies', { used_bytes: 900, size_bytes: 1000 }),
    );
    await graphStore.upsertEntity(makeEntity('share', 'music')); // no attrs

    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.resource).toBe('share/movies');
  });

  test('no entities of capacity-bearing kinds → returns []', async () => {
    // Insert a non-capacity kind
    await graphStore.upsertEntity(makeEntity('service', 'my-app'));
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();
    expect(obs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — multiple entities
// ---------------------------------------------------------------------------

describe('CapacityProbe.scan() — multiple entities', () => {
  test('multiple entities each get independent observations', async () => {
    await graphStore.upsertEntity(
      makeEntity('share', 'share-a', { used_bytes: 820, size_bytes: 1000 }),
    );
    await graphStore.upsertEntity(
      makeEntity('share', 'share-b', { used_bytes: 920, size_bytes: 1000 }),
    );
    await graphStore.upsertEntity(
      makeEntity('datastore', 'pg-c', { disk_used_bytes: 700, disk_limit_bytes: 1000 }),
    );

    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    // share-a (82 %) → capacity_warning
    // share-b (92 %) → capacity_critical
    // pg-c (70 %)    → no observation
    expect(obs).toHaveLength(2);
    const patterns = obs.map((o) => o.pattern).sort();
    expect(patterns).toEqual(['capacity_critical', 'capacity_warning']);

    const shareA = obs.find((o) => o.resource === 'share/share-a');
    expect(shareA?.pattern).toBe('capacity_warning');
    const shareB = obs.find((o) => o.resource === 'share/share-b');
    expect(shareB?.pattern).toBe('capacity_critical');
  });
});

// ---------------------------------------------------------------------------
// CapacityProbe — Probe interface conformance
// ---------------------------------------------------------------------------

describe('CapacityProbe — Probe interface', () => {
  test('implements the Probe interface correctly', () => {
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    expect(probe.id).toBe('capacity');
    expect(probe.platformId).toBe(PLATFORM);
    expect(probe.cadence).toBe('slow');
    expect(typeof probe.scan).toBe('function');
  });

  test('observations have a valid dedup_key', async () => {
    await graphStore.upsertEntity(
      makeEntity('datastore', 'my-db', { disk_used_bytes: 800, disk_limit_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.dedup_key).toBe(`${PLATFORM}:capacity_warning:datastore/my-db`);
  });

  test('observations have a valid UUID id and ISO discovered_at', async () => {
    await graphStore.upsertEntity(
      makeEntity('share', 'docs', { used_bytes: 900, size_bytes: 1000 }),
    );
    const probe = new CapacityProbe({ platformId: PLATFORM, graphStore });
    const obs = await probe.scan();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Date(obs[0]!.discovered_at).getTime()).toBeGreaterThan(0);
  });
});
