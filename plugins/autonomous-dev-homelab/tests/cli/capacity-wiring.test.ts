/**
 * Wiring proof for CapacityProbe (issue #44, invariant #62).
 *
 * Verifies that:
 *   1. `buildLiveProbes` includes the capacity probe when `capacityProbe`
 *      option is provided, and does NOT include it when absent.
 *   2. `ObservationCollector.runAll()` actually invokes the capacity probe's
 *      `scan()` method.
 *   3. Observations emitted by the capacity probe flow through the collector
 *      (persisted, returned from runAll).
 *   4. The capacity probe appears AFTER the datastore health probe in the
 *      probe list (ordering contract).
 *   5. CapacityProbe constructed as the observe CLI block does — with a
 *      GraphStore + pool-backed exec source — runs scan() without throwing.
 *
 * All pool/graph/connection calls are mocked — no live Docker, SSH, or Vault.
 */

import * as path from 'node:path';
import { CapacityProbe } from '../../src/observation/probes/capacity';
import { DatastoreHealthProbe } from '../../src/observation/probes/datastore-health';
import { buildLiveProbes } from '../../src/observation/live-probes';
import { ObservationCollector } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import { ObservationStore } from '../../src/observation/persistence';
import { ObservationPromoter } from '../../src/observation/promoter';
import { GraphStore } from '../../src/discovery/graph-store';
import type { HomelabConfig } from '../../src/config/types';
import { fileMutex } from '../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const PLATFORM_ID = 'test-nas-01';
const NOW = '2026-07-08T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Config stub
// ---------------------------------------------------------------------------

const CONFIG_WITH_SWARM: HomelabConfig = {
  version: 1,
  vault: {
    address: 'https://vault.test:8200',
    auth_method: 'approle',
    approle: { role_id_env: 'VAULT_ROLE_ID', secret_id_env: 'VAULT_SECRET_ID' },
  },
  hosts: [
    {
      hostname: 'swarm-01',
      platform: 'docker-swarm-manager',
      role: 'manager',
      ssh_fallback: {
        host: 'swarm-01',
        port: 22,
        user: 'ops',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key1' },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('capacity-wiring-');
  const graphPath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphPath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// Helper: minimal fake capacity probe (avoids needing a graphStore write)
// ---------------------------------------------------------------------------

function makeFakeCapacityProbe(observations: import('../../src/observation/types').Observation[] = []) {
  return {
    id: 'capacity',
    platformId: PLATFORM_ID,
    cadence: 'slow' as const,
    scan: jest.fn().mockResolvedValue(observations),
  };
}

function makeFakeDatastoreHealthProbe() {
  return {
    id: 'datastore-health',
    platformId: PLATFORM_ID,
    cadence: 'medium' as const,
    scan: jest.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// 1. buildLiveProbes includes / excludes capacity probe
// ---------------------------------------------------------------------------

describe('buildLiveProbes — capacityProbe option (issue #44)', () => {
  test('without capacityProbe option, capacity probe is NOT in the list', () => {
    const probes = buildLiveProbes(CONFIG_WITH_SWARM);
    expect(probes.every((p) => p.id !== 'capacity')).toBe(true);
  });

  test('with capacityProbe option, probe appears in the built list', () => {
    const capacityProbe = makeFakeCapacityProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe });
    expect(probes.some((p) => p.id === 'capacity')).toBe(true);
  });

  test('with capacityProbe only, probe count = host-probes + 1', () => {
    const capacityProbe = makeFakeCapacityProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe });
    // 1 swarm-manager → 1 swarm probe + 1 capacity probe = 2
    expect(probes).toHaveLength(2);
    expect(probes[probes.length - 1]).toBe(capacityProbe);
  });

  test('with all optional probes, ordering is alertProbe → datastoreHealth → capacity', () => {
    const alertProbe = {
      id: 'alert',
      platformId: 'monitoring',
      cadence: 'fast' as const,
      scan: jest.fn().mockResolvedValue([]),
    };
    const datastoreHealthProbe = makeFakeDatastoreHealthProbe();
    const capacityProbe = makeFakeCapacityProbe();

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, {
      alertProbe: alertProbe as unknown as import('../../src/observation/probes/alert').AlertProbe,
      datastoreHealthProbe,
      capacityProbe,
    });

    // 1 swarm probe + alert + datastore-health + capacity = 4
    expect(probes).toHaveLength(4);
    const ids = probes.map((p) => p.id);
    expect(ids[ids.length - 1]).toBe('capacity');
    expect(ids[ids.length - 2]).toBe('datastore-health');
    expect(ids[ids.length - 3]).toBe('alert');
  });

  test('capacity probe appears AFTER datastoreHealthProbe', () => {
    const datastoreHealthProbe = makeFakeDatastoreHealthProbe();
    const capacityProbe = makeFakeCapacityProbe();

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { datastoreHealthProbe, capacityProbe });

    const dsIdx = probes.findIndex((p) => p.id === 'datastore-health');
    const capIdx = probes.findIndex((p) => p.id === 'capacity');
    expect(dsIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(dsIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. ObservationCollector actually invokes the capacity probe
// ---------------------------------------------------------------------------

describe('ObservationCollector — runs capacity probe scan()', () => {
  test('collector invokes capacity probe scan() exactly once per runAll()', async () => {
    const capacityProbe = makeFakeCapacityProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    await collector.runAll();
    expect(capacityProbe.scan).toHaveBeenCalledTimes(1);
  });

  test('capacity probe observations flow through the collector', async () => {
    const fakeObs = {
      id: 'aaaabbbb-0000-4000-8000-000000000001',
      platform: PLATFORM_ID,
      pattern: 'capacity_warning' as const,
      resource: 'share/media',
      severity: 'P1' as const,
      discovered_at: NOW,
      dedup_key: `${PLATFORM_ID}:capacity_warning:share/media`,
    };

    const capacityProbe = makeFakeCapacityProbe([fakeObs]);
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    const collected = await collector.runAll();

    expect(collected.some((o) => o.pattern === 'capacity_warning')).toBe(true);
    expect(collected.some((o) => o.resource === 'share/media')).toBe(true);
  });

  test('capacity probe scan() error is swallowed — collector does not throw', async () => {
    const failingProbe = {
      id: 'capacity',
      platformId: PLATFORM_ID,
      cadence: 'slow' as const,
      scan: jest.fn().mockRejectedValue(new Error('graph unreachable')),
    };

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe: failingProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    // Must not throw
    await expect(collector.runAll()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Real CapacityProbe constructed as observe CLI block does
// ---------------------------------------------------------------------------

describe('CapacityProbe — real construction mirroring CLI observe block', () => {
  test('constructs with graphStore + pool-backed exec source and scan() does not throw', async () => {
    // Simulate the observe block in src/cli/index.ts:
    // primaryPlatformId from first host; pool-backed exec source;
    // empty graph → probe returns [].
    const primaryPlatformId = CONFIG_WITH_SWARM.hosts[0]!.hostname;
    const capacityExecSource = {
      platformId: primaryPlatformId,
      exec: jest.fn().mockRejectedValue(new Error('pool not connected')),
    };
    const probe = new CapacityProbe({
      platformId: primaryPlatformId,
      graphStore,
      execSource: capacityExecSource,
    });

    // Empty graph → scan() returns [] without throwing
    const obs = await probe.scan();
    expect(Array.isArray(obs)).toBe(true);
    expect(obs).toEqual([]);
  });

  test('scan() with a capacity-bearing entity in graph emits observations', async () => {
    const primaryPlatformId = CONFIG_WITH_SWARM.hosts[0]!.hostname;

    // Insert a share at 90 % fill into the graph
    await graphStore.upsertEntity({
      id: `share:${primaryPlatformId}:media`,
      kind: 'share',
      name: 'media',
      attributes: { used_bytes: 900, size_bytes: 1000 },
      source: 'unraid',
      platformId: primaryPlatformId,
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });

    // Exec source fails (pool not connected); falls back to attributes
    const probe = new CapacityProbe({
      platformId: primaryPlatformId,
      graphStore,
      execSource: {
        platformId: primaryPlatformId,
        exec: jest.fn().mockResolvedValue({ stdout: '', exitCode: 1 }),
      },
    });

    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('capacity_critical');
    expect(obs[0]!.resource).toBe('share/media');
  });

  test('CapacityProbe implements the Probe interface and has id=capacity, cadence=slow', () => {
    const probe = new CapacityProbe({ platformId: PLATFORM_ID, graphStore });
    expect(probe.id).toBe('capacity');
    expect(probe.cadence).toBe('slow');
    expect(probe.platformId).toBe(PLATFORM_ID);
    expect(typeof probe.scan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — existing tests not broken
// ---------------------------------------------------------------------------

describe('buildLiveProbes — backward compatibility', () => {
  test('without any optional probes, buildLiveProbes behaves as before', () => {
    const probes = buildLiveProbes(CONFIG_WITH_SWARM);
    // Only the 1 swarm probe — no optional probes
    expect(probes).toHaveLength(1);
    expect(probes[0]!.id).toMatch(/swarm/);
  });

  test('datastoreHealthProbe without capacityProbe works as before', () => {
    const datastoreHealthProbe = makeFakeDatastoreHealthProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { datastoreHealthProbe });
    expect(probes).toHaveLength(2);
    expect(probes[probes.length - 1]!.id).toBe('datastore-health');
    expect(probes.every((p) => p.id !== 'capacity')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. DatastoreHealthProbe + CapacityProbe coexist in the collector
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe + CapacityProbe coexist', () => {
  test('both probes run and their observations are collected independently', async () => {
    const execSrc = {
      platformId: PLATFORM_ID,
      exec: jest.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    };

    // Insert a datastore entity (will be healthy → no observation from DS probe)
    // Insert a capacity entity (at 90 % → capacity_critical)
    await graphStore.upsertEntity({
      id: `share:${PLATFORM_ID}:big-share`,
      kind: 'share',
      name: 'big-share',
      attributes: { used_bytes: 900, size_bytes: 1000 },
      source: 'unraid',
      platformId: PLATFORM_ID,
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });

    const datastoreHealthProbe = new DatastoreHealthProbe(PLATFORM_ID, graphStore, execSrc);
    const capacityProbe = new CapacityProbe({
      platformId: PLATFORM_ID,
      graphStore,
      execSource: execSrc,
    });

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, {
      datastoreHealthProbe,
      capacityProbe,
    });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    const collected = await collector.runAll();

    // Capacity probe emits capacity_critical for share/big-share
    expect(collected.some((o) => o.pattern === 'capacity_critical')).toBe(true);
    // No datastore_unhealthy (no datastore entities in graph)
    expect(collected.every((o) => o.pattern !== 'datastore_unhealthy')).toBe(true);
  });
});
