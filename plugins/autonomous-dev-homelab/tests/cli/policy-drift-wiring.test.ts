/**
 * Wiring proof for PolicyDriftProbe (issue #35, invariant #62).
 *
 * Verifies:
 *   1. `buildLiveProbes` includes the policy-drift probe when `policyDriftProbe`
 *      option is provided, and does NOT include it when absent.
 *   2. The policy-drift probe appears AFTER the capacity probe in the list
 *      (ordering contract: drift is last).
 *   3. `ObservationCollector.runAll()` actually invokes the probe's `scan()`.
 *   4. Observations emitted by the probe flow through the collector
 *      (returned from runAll, pattern === 'policy_drift').
 *   5. A scan() error is swallowed — the collector does not throw.
 *   6. PolicyDriftProbe constructed as the observe CLI block does — with a
 *      GraphStore + platformId — runs scan() without throwing on an empty graph.
 *   7. All optional probes coexist: alertProbe, datastoreHealthProbe,
 *      capacityProbe, policyDriftProbe — ordering is alert → ds → cap → drift.
 *
 * No live Docker, SSH, or Vault calls. Graph store backed by temp YAML files.
 */

import * as path from 'node:path';
import { PolicyDriftProbe } from '../../src/observation/probes/policy-drift';
import { buildLiveProbes } from '../../src/observation/live-probes';
import { ObservationCollector } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import { ObservationStore } from '../../src/observation/persistence';
import { ObservationPromoter } from '../../src/observation/promoter';
import { GraphStore } from '../../src/discovery/graph-store';
import type { HomelabConfig } from '../../src/config/types';
import type { Observation } from '../../src/observation/types';
import { fileMutex } from '../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Config stub (mirrors the pattern used in capacity-wiring.test.ts)
// ---------------------------------------------------------------------------

const PLATFORM_ID = 'test-swarm-01';

const CONFIG_WITH_SWARM: HomelabConfig = {
  version: 1,
  vault: {
    address: 'https://vault.test:8200',
    auth_method: 'approle',
    approle: { role_id_env: 'VAULT_ROLE_ID', secret_id_env: 'VAULT_SECRET_ID' },
  },
  hosts: [
    {
      hostname: PLATFORM_ID,
      platform: 'docker-swarm-manager',
      role: 'manager',
      ssh_fallback: {
        host: PLATFORM_ID,
        port: 22,
        user: 'ops',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key1' },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Fake probe factories
// ---------------------------------------------------------------------------

function makeFakePolicyDriftProbe(
  observations: Observation[] = [],
): jest.Mocked<Pick<PolicyDriftProbe, 'id' | 'platformId' | 'cadence' | 'scan'>> & {
  id: string;
  platformId: string;
  cadence: 'slow';
  scan: jest.Mock;
} {
  return {
    id: 'policy-drift',
    platformId: PLATFORM_ID,
    cadence: 'slow' as const,
    scan: jest.fn().mockResolvedValue(observations),
  };
}

function makeFakeCapacityProbe() {
  return {
    id: 'capacity',
    platformId: PLATFORM_ID,
    cadence: 'slow' as const,
    scan: jest.fn().mockResolvedValue([]),
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
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('policy-drift-wiring-');
  const graphPath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphPath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// 1. buildLiveProbes includes / excludes policy-drift probe
// ---------------------------------------------------------------------------

describe('buildLiveProbes — policyDriftProbe option (issue #35)', () => {
  test('without policyDriftProbe option, policy-drift probe is NOT in the list', () => {
    const probes = buildLiveProbes(CONFIG_WITH_SWARM);
    expect(probes.every((p) => p.id !== 'policy-drift')).toBe(true);
  });

  test('with policyDriftProbe option, probe appears in the built list', () => {
    const policyDriftProbe = makeFakePolicyDriftProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { policyDriftProbe });
    expect(probes.some((p) => p.id === 'policy-drift')).toBe(true);
  });

  test('with policyDriftProbe only, probe count = host-probes + 1', () => {
    const policyDriftProbe = makeFakePolicyDriftProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { policyDriftProbe });
    // 1 swarm-manager → 1 swarm probe + 1 policy-drift probe = 2
    expect(probes).toHaveLength(2);
    expect(probes[probes.length - 1]).toBe(policyDriftProbe);
  });

  test('policy-drift probe appears AFTER capacity probe', () => {
    const capacityProbe = makeFakeCapacityProbe();
    const policyDriftProbe = makeFakePolicyDriftProbe();

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe, policyDriftProbe });

    const capIdx = probes.findIndex((p) => p.id === 'capacity');
    const driftIdx = probes.findIndex((p) => p.id === 'policy-drift');
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeGreaterThan(capIdx);
  });

  test('all optional probes present: ordering is alert → datastore → capacity → policy-drift', () => {
    const alertProbe = {
      id: 'alert',
      platformId: 'monitoring',
      cadence: 'fast' as const,
      scan: jest.fn().mockResolvedValue([]),
    };
    const datastoreHealthProbe = makeFakeDatastoreHealthProbe();
    const capacityProbe = makeFakeCapacityProbe();
    const policyDriftProbe = makeFakePolicyDriftProbe();

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, {
      alertProbe: alertProbe as unknown as import('../../src/observation/probes/alert').AlertProbe,
      datastoreHealthProbe,
      capacityProbe,
      policyDriftProbe,
    });

    // 1 swarm + alert + datastore-health + capacity + policy-drift = 5
    expect(probes).toHaveLength(5);
    const ids = probes.map((p) => p.id);
    expect(ids[ids.length - 1]).toBe('policy-drift');
    expect(ids[ids.length - 2]).toBe('capacity');
    expect(ids[ids.length - 3]).toBe('datastore-health');
    expect(ids[ids.length - 4]).toBe('alert');
  });
});

// ---------------------------------------------------------------------------
// 2. ObservationCollector actually invokes the policy-drift probe
// ---------------------------------------------------------------------------

describe('ObservationCollector — runs policy-drift probe scan()', () => {
  test('collector invokes policy-drift probe scan() exactly once per runAll()', async () => {
    const policyDriftProbe = makeFakePolicyDriftProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { policyDriftProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    await collector.runAll();
    expect(policyDriftProbe.scan).toHaveBeenCalledTimes(1);
  });

  test('policy_drift observations from probe flow through the collector', async () => {
    const fakeObs: Observation = {
      id: 'aaaabbbb-0000-4000-8000-000000000099',
      platform: PLATFORM_ID,
      pattern: 'policy_drift',
      resource: 'service/app-01@node/mgr-01',
      severity: 'P0',
      discovered_at: '2026-07-08T10:00:00.000Z',
      dedup_key: `${PLATFORM_ID}:policy_drift:rule/no-workloads-on-manager/svc:app-01`,
      details: {
        rule_id: 'no-workloads-on-manager',
        rule_type: 'placement',
        rule_effect: 'deny',
        expected: 'no workloads on node with capability manager',
        observed: 'service app-01 is on manager node mgr-01',
        node_id: 'node:mgr-01',
        node_name: 'mgr-01',
        service_id: 'svc:app-01',
        service_name: 'app-01',
      },
    };

    const policyDriftProbe = makeFakePolicyDriftProbe([fakeObs]);
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { policyDriftProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    const collected = await collector.runAll();
    expect(collected.some((o) => o.pattern === 'policy_drift')).toBe(true);
    expect(collected.some((o) => o.resource === 'service/app-01@node/mgr-01')).toBe(true);
  });

  test('policy-drift probe scan() error is swallowed — collector does not throw', async () => {
    const failingProbe = {
      id: 'policy-drift',
      platformId: PLATFORM_ID,
      cadence: 'slow' as const,
      scan: jest.fn().mockRejectedValue(new Error('graph unreachable')),
    };

    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { policyDriftProbe: failingProbe });

    const store = new ObservationStore(tmpDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    });
    const collector = new ObservationCollector({ probes, dedup, store, promoter });

    await expect(collector.runAll()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Real PolicyDriftProbe constructed as observe CLI block does
// ---------------------------------------------------------------------------

describe('PolicyDriftProbe — real construction mirroring CLI observe block', () => {
  test('constructs with graphStore + platformId and scan() does not throw on empty graph', async () => {
    // Simulates the observe block in src/cli/index.ts:
    // primaryPlatformId from first host; graph store constructed from graphPath.
    const primaryPlatformId = CONFIG_WITH_SWARM.hosts[0]!.hostname;
    const probe = new PolicyDriftProbe({
      platformId: primaryPlatformId,
      graphStore,
    });

    // Empty graph → scan() returns [] without throwing
    const obs = await probe.scan();
    expect(Array.isArray(obs)).toBe(true);
    expect(obs).toEqual([]);
  });

  test('real probe with a manager-node workload in graph emits policy_drift observations', async () => {
    const NOW = '2026-07-08T10:00:00.000Z';
    const primaryPlatformId = CONFIG_WITH_SWARM.hosts[0]!.hostname;

    // Insert a manager node into the graph
    await graphStore.upsertEntity({
      id: 'node:mgr-real',
      kind: 'node',
      name: 'mgr-real',
      attributes: { manager_status: 'leader' },
      source: 'test',
      platformId: primaryPlatformId,
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });
    // Insert a service hosted on it
    await graphStore.upsertEntity({
      id: 'svc:web-real',
      kind: 'service',
      name: 'web-real',
      attributes: { role: 'web' },
      source: 'test',
      platformId: primaryPlatformId,
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });
    // Edge: manager hosts the service
    await graphStore.upsertEdge({
      id: 'edge:mgr-real:web-real',
      from: 'node:mgr-real',
      to: 'svc:web-real',
      type: 'hosts',
      discovered_at: NOW,
      last_seen: NOW,
      status: 'active',
    });

    const probe = new PolicyDriftProbe({
      platformId: primaryPlatformId,
      graphStore,
    });

    const obs = await probe.scan();
    const driftObs = obs.filter((o) => o.pattern === 'policy_drift');
    expect(driftObs.length).toBeGreaterThanOrEqual(1);
    // At minimum the no-workloads-on-manager rule fires
    expect(
      driftObs.some((o) => o.details?.['rule_id'] === 'no-workloads-on-manager'),
    ).toBe(true);
  });

  test('PolicyDriftProbe implements the Probe interface and has id=policy-drift, cadence=slow', () => {
    const probe = new PolicyDriftProbe({ platformId: PLATFORM_ID, graphStore });
    expect(probe.id).toBe('policy-drift');
    expect(probe.cadence).toBe('slow');
    expect(probe.platformId).toBe(PLATFORM_ID);
    expect(typeof probe.scan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — existing tests not broken by new option
// ---------------------------------------------------------------------------

describe('buildLiveProbes — backward compatibility', () => {
  test('without any optional probes, buildLiveProbes behaves as before', () => {
    const probes = buildLiveProbes(CONFIG_WITH_SWARM);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.id).toMatch(/swarm/);
  });

  test('capacityProbe without policyDriftProbe works as before', () => {
    const capacityProbe = makeFakeCapacityProbe();
    const probes = buildLiveProbes(CONFIG_WITH_SWARM, { capacityProbe });
    expect(probes).toHaveLength(2);
    expect(probes[probes.length - 1]!.id).toBe('capacity');
    expect(probes.every((p) => p.id !== 'policy-drift')).toBe(true);
  });
});
