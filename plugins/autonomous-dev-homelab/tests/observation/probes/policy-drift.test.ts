/**
 * Unit tests for `PolicyDriftProbe` (issue #35, invariant #62).
 *
 * Verifies the probe correctly detects policy violations from the live graph:
 *
 *   1. Manager-node workload violation:
 *      A service co-located on a node tagged `manager` → `policy_drift` P0
 *      (rule: `no-workloads-on-manager`, effect: deny).
 *
 *   2. Anti-affinity co-location violation:
 *      Two `media`-role services on the same node → `policy_drift` P0
 *      (rule: `media-anti-affinity`, effect: deny).
 *
 *   3. arr-stack anti-affinity:
 *      Two `arr-stack`-role services on the same node → `policy_drift` P0
 *      (rule: `arr-stack-anti-affinity`, maxPerNode: 1, effect: deny).
 *
 *   4. GPU-required for media:
 *      A `media`-role service on a node without `gpu` capability → `policy_drift` P0
 *      (rule: `gpu-required-for-media`, effect: deny).
 *
 *   5. Compliant placement → no observations.
 *
 *   6. Graceful degradation: graph unreachable → [].
 *
 *   7. Details structure: rule_id, rule_type, expected, observed, node/service ids.
 *
 *   8. Dedup key is stable per (rule_id, service_id).
 *
 * All graph and rule derivation calls use mocked GraphStore instances backed
 * by in-process YAML files (temp-dir). No live Docker/SSH/Vault calls.
 * Invariant #62: no homelab-specific instance names in test data.
 */

import * as path from 'node:path';
import { PolicyDriftProbe } from '../../../src/observation/probes/policy-drift';
import { GraphStore } from '../../../src/discovery/graph-store';
import type { Entity } from '../../../src/discovery/graph-types';
import type { Edge } from '../../../src/discovery/graph-types';
import { fileMutex } from '../../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM = 'homelab';
const NOW = '2026-07-08T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a node entity with the given attributes.
 */
function makeNode(
  id: string,
  name: string,
  attrs: Record<string, unknown> = {},
): Entity {
  return {
    id,
    kind: 'node',
    name,
    attributes: attrs,
    source: 'test',
    platformId: PLATFORM,
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
  };
}

/**
 * Build a service entity with the given role.
 */
function makeService(id: string, name: string, role: string): Entity {
  return {
    id,
    kind: 'service',
    name,
    attributes: { role },
    source: 'test',
    platformId: PLATFORM,
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
  };
}

/**
 * Build a `hosts` edge from a node to a service.
 */
function hostsEdge(nodeId: string, serviceId: string): Edge {
  return {
    id: `edge:${nodeId}:${serviceId}`,
    from: nodeId,
    to: serviceId,
    type: 'hosts',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('policy-drift-test-');
  const graphPath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphPath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// 1. Manager-node workload violation
// ---------------------------------------------------------------------------

describe('manager-node workload violation (no-workloads-on-manager rule)', () => {
  test('service on manager node → policy_drift P0 observation', async () => {
    // Node tagged manager (via manager_status attribute)
    const managerNode = makeNode('node:mgr-01', 'mgr-01', {
      manager_status: 'leader',
    });
    // Service with any role running on it
    const appSvc = makeService('svc:app-01', 'app-01', 'web');
    const edge = hostsEdge(managerNode.id, appSvc.id);

    await graphStore.upsertEntity(managerNode);
    await graphStore.upsertEntity(appSvc);
    await graphStore.upsertEdge(edge);

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const driftObs = observations.filter((o) => o.pattern === 'policy_drift');
    // Must have at least one violation for the no-workloads-on-manager rule
    const managerViolation = driftObs.find(
      (o) => typeof o.details?.['rule_id'] === 'string' &&
              o.details['rule_id'] === 'no-workloads-on-manager',
    );
    expect(managerViolation).toBeDefined();
    expect(managerViolation!.severity).toBe('P0');
    expect(managerViolation!.platform).toBe(PLATFORM);
    expect(managerViolation!.resource).toContain('app-01');
    expect(managerViolation!.resource).toContain('mgr-01');
  });

  test('worker node with service → no manager-violation observation', async () => {
    // Plain worker node (no manager attributes)
    const workerNode = makeNode('node:worker-01', 'worker-01', {});
    const appSvc = makeService('svc:app-02', 'app-02', 'web');
    const edge = hostsEdge(workerNode.id, appSvc.id);

    await graphStore.upsertEntity(workerNode);
    await graphStore.upsertEntity(appSvc);
    await graphStore.upsertEdge(edge);

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const managerViolations = observations.filter(
      (o) => o.pattern === 'policy_drift' &&
              o.details?.['rule_id'] === 'no-workloads-on-manager',
    );
    expect(managerViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Anti-affinity co-location: media services
// ---------------------------------------------------------------------------

describe('media anti-affinity violation', () => {
  test('two media-role services on same node → policy_drift P0 observation', async () => {
    // GPU-capable node (required by gpu-required-for-media; worker, not manager)
    const gpuNode = makeNode('node:gpu-01', 'gpu-01', { gpu_count: 1 });
    const mediaA = makeService('svc:media-a', 'media-a', 'media');
    const mediaB = makeService('svc:media-b', 'media-b', 'media');

    await graphStore.upsertEntity(gpuNode);
    await graphStore.upsertEntity(mediaA);
    await graphStore.upsertEntity(mediaB);
    await graphStore.upsertEdge(hostsEdge(gpuNode.id, mediaA.id));
    await graphStore.upsertEdge(hostsEdge(gpuNode.id, mediaB.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const antiAffinityViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'media-anti-affinity',
    );
    // At least one excess service flagged
    expect(antiAffinityViolations.length).toBeGreaterThanOrEqual(1);
    expect(antiAffinityViolations[0]!.severity).toBe('P0');
  });

  test('one media-role service on a node → no anti-affinity violation', async () => {
    const gpuNode = makeNode('node:gpu-02', 'gpu-02', { gpu_count: 2 });
    const mediaA = makeService('svc:media-c', 'media-c', 'media');

    await graphStore.upsertEntity(gpuNode);
    await graphStore.upsertEntity(mediaA);
    await graphStore.upsertEdge(hostsEdge(gpuNode.id, mediaA.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const antiAffinityViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'media-anti-affinity',
    );
    expect(antiAffinityViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. arr-stack anti-affinity
// ---------------------------------------------------------------------------

describe('arr-stack anti-affinity violation', () => {
  test('two arr-stack services on same node → policy_drift P0 observation', async () => {
    const workerNode = makeNode('node:worker-arr', 'worker-arr', {});
    const svcA = makeService('svc:arr-a', 'arr-a', 'arr-stack');
    const svcB = makeService('svc:arr-b', 'arr-b', 'arr-stack');

    await graphStore.upsertEntity(workerNode);
    await graphStore.upsertEntity(svcA);
    await graphStore.upsertEntity(svcB);
    await graphStore.upsertEdge(hostsEdge(workerNode.id, svcA.id));
    await graphStore.upsertEdge(hostsEdge(workerNode.id, svcB.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const arrViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'arr-stack-anti-affinity',
    );
    expect(arrViolations.length).toBeGreaterThanOrEqual(1);
    expect(arrViolations[0]!.severity).toBe('P0');
  });

  test('one arr-stack service per node → no violation', async () => {
    const nodeA = makeNode('node:worker-a', 'worker-a', {});
    const nodeB = makeNode('node:worker-b', 'worker-b', {});
    const svcA = makeService('svc:arr-c', 'arr-c', 'arr-stack');
    const svcB = makeService('svc:arr-d', 'arr-d', 'arr-stack');

    await graphStore.upsertEntity(nodeA);
    await graphStore.upsertEntity(nodeB);
    await graphStore.upsertEntity(svcA);
    await graphStore.upsertEntity(svcB);
    await graphStore.upsertEdge(hostsEdge(nodeA.id, svcA.id));
    await graphStore.upsertEdge(hostsEdge(nodeB.id, svcB.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const arrViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'arr-stack-anti-affinity',
    );
    expect(arrViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. GPU required for media
// ---------------------------------------------------------------------------

describe('gpu-required-for-media violation', () => {
  test('media service on non-GPU node → policy_drift P0 observation', async () => {
    // Worker node without any GPU capability
    const plainNode = makeNode('node:plain-01', 'plain-01', {});
    const mediaSvc = makeService('svc:media-nogpu', 'media-nogpu', 'media');

    await graphStore.upsertEntity(plainNode);
    await graphStore.upsertEntity(mediaSvc);
    await graphStore.upsertEdge(hostsEdge(plainNode.id, mediaSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const gpuViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'gpu-required-for-media',
    );
    expect(gpuViolations.length).toBeGreaterThanOrEqual(1);
    expect(gpuViolations[0]!.severity).toBe('P0');
    expect(gpuViolations[0]!.details?.['rule_type']).toBe('placement');
  });

  test('media service on GPU node → no gpu-required violation', async () => {
    const gpuNode = makeNode('node:gpu-03', 'gpu-03', { gpu_count: 1 });
    const mediaSvc = makeService('svc:media-ok', 'media-ok', 'media');

    await graphStore.upsertEntity(gpuNode);
    await graphStore.upsertEntity(mediaSvc);
    await graphStore.upsertEdge(hostsEdge(gpuNode.id, mediaSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const gpuViolations = observations.filter(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'gpu-required-for-media',
    );
    expect(gpuViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Compliant placement → no observations
// ---------------------------------------------------------------------------

describe('compliant placement — no observations', () => {
  test('worker node with a web service + no policy-violating conditions → no policy_drift', async () => {
    const workerNode = makeNode('node:clean-worker', 'clean-worker', {});
    const webSvc = makeService('svc:web-01', 'web-01', 'web');

    await graphStore.upsertEntity(workerNode);
    await graphStore.upsertEntity(webSvc);
    await graphStore.upsertEdge(hostsEdge(workerNode.id, webSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const driftObs = observations.filter((o) => o.pattern === 'policy_drift');
    expect(driftObs).toHaveLength(0);
  });

  test('empty graph → no observations', async () => {
    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();
    expect(observations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Graceful degradation: graph unreachable
// ---------------------------------------------------------------------------

describe('graceful degradation', () => {
  test('scan() returns [] when graph throws on all()', async () => {
    // Use a path that is a directory (not a YAML file) to force a read error.
    const badGraphStore = new GraphStore(tmpDir, { mutex: fileMutex() });
    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore: badGraphStore });
    // Must not throw — must return []
    const observations = await probe.scan();
    expect(Array.isArray(observations)).toBe(true);
    // The store returns empty doc for ENOENT/directory-as-file; graceful result.
    expect(observations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Details structure
// ---------------------------------------------------------------------------

describe('observation details structure', () => {
  test('violation observation carries required detail fields', async () => {
    const managerNode = makeNode('node:detail-mgr', 'detail-mgr', {
      manager_status: 'Leader',
    });
    const appSvc = makeService('svc:detail-app', 'detail-app', 'backend');

    await graphStore.upsertEntity(managerNode);
    await graphStore.upsertEntity(appSvc);
    await graphStore.upsertEdge(hostsEdge(managerNode.id, appSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    const managerViolation = observations.find(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'no-workloads-on-manager',
    );
    expect(managerViolation).toBeDefined();

    const details = managerViolation!.details!;
    expect(typeof details['rule_id']).toBe('string');
    expect(typeof details['rule_type']).toBe('string');
    expect(typeof details['rule_effect']).toBe('string');
    expect(typeof details['expected']).toBe('string');
    expect(typeof details['observed']).toBe('string');
    expect(details['node_id']).toBe(managerNode.id);
    expect(details['node_name']).toBe('detail-mgr');
    expect(details['service_id']).toBe(appSvc.id);
    expect(details['service_name']).toBe('detail-app');
  });
});

// ---------------------------------------------------------------------------
// 8. Dedup key stability
// ---------------------------------------------------------------------------

describe('dedup_key stability', () => {
  test('dedup_key is stable per (rule_id, service_id) across sweeps', async () => {
    const managerNode = makeNode('node:dedup-mgr', 'dedup-mgr', {
      manager_status: 'reachable',
    });
    const appSvc = makeService('svc:dedup-app', 'dedup-app', 'cache');

    await graphStore.upsertEntity(managerNode);
    await graphStore.upsertEntity(appSvc);
    await graphStore.upsertEdge(hostsEdge(managerNode.id, appSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });

    const obs1 = await probe.scan();
    const obs2 = await probe.scan();

    const key1 = obs1
      .find((o) => o.details?.['rule_id'] === 'no-workloads-on-manager')
      ?.dedup_key;
    const key2 = obs2
      .find((o) => o.details?.['rule_id'] === 'no-workloads-on-manager')
      ?.dedup_key;

    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).toBe(key2);

    // Key must embed the rule_id and service_id
    expect(key1).toContain('policy_drift');
    expect(key1).toContain('no-workloads-on-manager');
    expect(key1).toContain(appSvc.id);
  });
});

// ---------------------------------------------------------------------------
// 9. Probe interface compliance
// ---------------------------------------------------------------------------

describe('Probe interface compliance', () => {
  test('PolicyDriftProbe has correct id, cadence, platformId', () => {
    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    expect(probe.id).toBe('policy-drift');
    expect(probe.cadence).toBe('slow');
    expect(probe.platformId).toBe(PLATFORM);
    expect(typeof probe.scan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 10. require-approval rules produce P1
// ---------------------------------------------------------------------------

describe('require-approval rules produce P1 severity', () => {
  test('storage node with workload → policy_drift P1 (storage-array-protection rule)', async () => {
    // Unraid storage node — gets `array` + `storage` capability tags
    const storageNode = makeNode('node:nas-01', 'nas-01', {
      array_state: 'Started',
      platform_type: 'unraid',
    });
    const appSvc = makeService('svc:nas-app', 'nas-app', 'backup');

    await graphStore.upsertEntity(storageNode);
    await graphStore.upsertEntity(appSvc);
    await graphStore.upsertEdge(hostsEdge(storageNode.id, appSvc.id));

    const probe = new PolicyDriftProbe({ platformId: PLATFORM, graphStore });
    const observations = await probe.scan();

    // storage-array-protection: require-approval → P1
    const storageViolation = observations.find(
      (o) =>
        o.pattern === 'policy_drift' &&
        o.details?.['rule_id'] === 'storage-array-protection',
    );
    // storage-array-protection is only emitted when topology has storage nodes;
    // since we have one, the rule must appear.
    expect(storageViolation).toBeDefined();
    expect(storageViolation!.severity).toBe('P1');
    expect(storageViolation!.details?.['rule_effect']).toBe('require-approval');
  });
});
