/**
 * Tests for `src/rules/topology.ts` (issue #34).
 *
 * Verifies:
 *   - Capability tag inference from entity attributes and graph neighbors.
 *   - Env-tier and role derivation.
 *   - TopologyAnalyzer.analyze() processes all node/platform entities and
 *     produces deterministic, sorted output.
 *   - Invariant #62: no entity names or ids appear in the tag/role/env
 *     derivation logic — only observable attributes are tested.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  inferCapabilityTags,
  inferEnvTier,
  inferNodeRole,
  TopologyAnalyzer,
} from '../../src/rules/topology';
import { GraphStore } from '../../src/discovery/graph-store';
import type { Entity } from '../../src/discovery/graph-types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<Entity> & { id: string; kind: string }): Entity {
  return {
    id: overrides.id,
    kind: overrides.kind,
    name: overrides.name ?? overrides.id,
    attributes: overrides.attributes ?? {},
    source: overrides.source ?? 'test',
    discovered_at: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    status: overrides.status ?? 'active',
  };
}

// ---------------------------------------------------------------------------
// inferCapabilityTags
// ---------------------------------------------------------------------------

describe('inferCapabilityTags', () => {
  test('gpu: numeric gpu_count > 0 → gpu tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { gpu_count: 2 } });
    expect(inferCapabilityTags(entity, [])).toContain('gpu');
  });

  test('gpu: string gpu_count > 0 → gpu tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { gpu_count: '1' } });
    expect(inferCapabilityTags(entity, [])).toContain('gpu');
  });

  test('gpu: gpu_count 0 → no gpu tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { gpu_count: 0 } });
    expect(inferCapabilityTags(entity, [])).not.toContain('gpu');
  });

  test('gpu: gpu neighbor → gpu tag even without attribute', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    const gpuNeighbor = makeEntity({ id: 'gpu1', kind: 'gpu' });
    expect(inferCapabilityTags(entity, [gpuNeighbor])).toContain('gpu');
  });

  test('array: array_state attribute → array tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { array_state: 'STARTED' } });
    expect(inferCapabilityTags(entity, [])).toContain('array');
  });

  test('array: array_state attribute → also adds storage tag (cascade)', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { array_state: 'STARTED' } });
    // array tag cascades to storage tag: the array IS the storage device.
    expect(inferCapabilityTags(entity, [])).toContain('storage');
  });

  test('array: storage-array neighbor → array tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    const arrNeighbor = makeEntity({ id: 'arr1', kind: 'storage-array' });
    expect(inferCapabilityTags(entity, [arrNeighbor])).toContain('array');
  });

  test('storage: share neighbor → storage tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    const shareNeighbor = makeEntity({ id: 's1', kind: 'share' });
    expect(inferCapabilityTags(entity, [shareNeighbor])).toContain('storage');
  });

  test('storage: storage-volume neighbor → storage tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    const volNeighbor = makeEntity({ id: 'v1', kind: 'storage-volume' });
    expect(inferCapabilityTags(entity, [volNeighbor])).toContain('storage');
  });

  test('storage: role attribute containing storage → storage tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { role: 'storage' } });
    expect(inferCapabilityTags(entity, [])).toContain('storage');
  });

  test('manager: manager_status=Leader → manager tag', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { manager_status: 'Leader' },
    });
    expect(inferCapabilityTags(entity, [])).toContain('manager');
  });

  test('manager: manager_status=Reachable → manager tag', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { manager_status: 'Reachable' },
    });
    expect(inferCapabilityTags(entity, [])).toContain('manager');
  });

  test('manager: node_role=control-plane → manager tag', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { node_role: 'control-plane' },
    });
    expect(inferCapabilityTags(entity, [])).toContain('manager');
  });

  test('manager: platform_type=proxmox → manager tag', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'platform',
      attributes: { platform_type: 'proxmox' },
    });
    expect(inferCapabilityTags(entity, [])).toContain('manager');
  });

  test('manager: manager tag → no worker tag', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { manager_status: 'Leader' },
    });
    const tags = inferCapabilityTags(entity, []);
    expect(tags).toContain('manager');
    expect(tags).not.toContain('worker');
  });

  test('worker: plain node with no manager signals → worker tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferCapabilityTags(entity, [])).toContain('worker');
  });

  test('worker: plain platform with no manager signals → worker tag', () => {
    const entity = makeEntity({ id: 'p1', kind: 'platform' });
    expect(inferCapabilityTags(entity, [])).toContain('worker');
  });

  test('tags are sorted alphabetically', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { gpu_count: 1, array_state: 'STARTED' },
    });
    const tags = inferCapabilityTags(entity, [makeEntity({ id: 's1', kind: 'share' })]);
    const sorted = [...tags].sort();
    expect(tags).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// inferEnvTier
// ---------------------------------------------------------------------------

describe('inferEnvTier', () => {
  test('explicit env attribute takes priority', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { env: 'staging' } });
    expect(inferEnvTier(entity, [])).toBe('staging');
  });

  test('env_tier attribute used when env absent', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { env_tier: 'dev' } });
    expect(inferEnvTier(entity, [])).toBe('dev');
  });

  test('environment attribute used as fallback', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { environment: 'prod' },
    });
    expect(inferEnvTier(entity, [])).toBe('prod');
  });

  test('manager tag → infra when no explicit attribute', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferEnvTier(entity, ['manager'])).toBe('infra');
  });

  test('array tag → prod when no explicit attribute', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferEnvTier(entity, ['array'])).toBe('prod');
  });

  test('no signals → unknown', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferEnvTier(entity, [])).toBe('unknown');
  });

  test('explicit attribute overrides manager tag', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node', attributes: { env: 'prod' } });
    expect(inferEnvTier(entity, ['manager'])).toBe('prod');
  });
});

// ---------------------------------------------------------------------------
// inferNodeRole
// ---------------------------------------------------------------------------

describe('inferNodeRole', () => {
  test('explicit role attribute used first', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'node',
      attributes: { role: 'reverse-proxy' },
    });
    expect(inferNodeRole(entity, [])).toBe('reverse-proxy');
  });

  test('proxmox platform_type → hypervisor', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'platform',
      attributes: { platform_type: 'proxmox' },
    });
    expect(inferNodeRole(entity, [])).toBe('hypervisor');
  });

  test('unraid platform_type → storage', () => {
    const entity = makeEntity({
      id: 'n1',
      kind: 'platform',
      attributes: { platform_type: 'unraid' },
    });
    expect(inferNodeRole(entity, [])).toBe('storage');
  });

  test('manager tag → manager', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferNodeRole(entity, ['manager'])).toBe('manager');
  });

  test('array tag → storage', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferNodeRole(entity, ['array'])).toBe('storage');
  });

  test('no signals → compute', () => {
    const entity = makeEntity({ id: 'n1', kind: 'node' });
    expect(inferNodeRole(entity, [])).toBe('compute');
  });
});

// ---------------------------------------------------------------------------
// TopologyAnalyzer.analyze()
// ---------------------------------------------------------------------------

describe('TopologyAnalyzer', () => {
  let dataDir: string;
  let graphStore: GraphStore;

  beforeEach(async () => {
    dataDir = await mkTempDir('topology-analyzer-');
    const graphPath = path.join(dataDir, 'inventory-graph.yaml');
    graphStore = new GraphStore(graphPath);
  });

  afterEach(async () => {
    await rmTempDir(dataDir);
  });

  test('returns empty nodes list when graph is empty', async () => {
    const analyzer = new TopologyAnalyzer(graphStore, {
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    const descriptor = await analyzer.analyze();
    expect(descriptor.nodes).toHaveLength(0);
    expect(descriptor.generated_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('skips non-node/platform entities', async () => {
    await graphStore.upsertEntity(
      makeEntity({ id: 'svc1', kind: 'service', attributes: { role: 'media' } }),
    );
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    expect(descriptor.nodes).toHaveLength(0);
  });

  test('derives tags from a GPU-capable node entity', async () => {
    await graphStore.upsertEntity(
      makeEntity({ id: 'node1', kind: 'node', attributes: { gpu_count: 1 } }),
    );
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    expect(descriptor.nodes).toHaveLength(1);
    const n = descriptor.nodes[0]!;
    expect(n.capability_tags).toContain('gpu');
    expect(n.capability_tags).toContain('worker');
    expect(n.capability_tags).not.toContain('manager');
  });

  test('derives manager tag from manager_status attribute', async () => {
    await graphStore.upsertEntity(
      makeEntity({
        id: 'node-mgr',
        kind: 'node',
        attributes: { manager_status: 'Leader' },
      }),
    );
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    const n = descriptor.nodes[0]!;
    expect(n.capability_tags).toContain('manager');
    expect(n.capability_tags).not.toContain('worker');
    expect(n.role).toBe('manager');
    expect(n.env_tier).toBe('infra');
  });

  test('derives gpu tag from a gpu-kind neighbor entity', async () => {
    await graphStore.upsertEntity(makeEntity({ id: 'node2', kind: 'node' }));
    await graphStore.upsertEntity(makeEntity({ id: 'gpu-0', kind: 'gpu' }));
    await graphStore.upsertEdge({
      id: 'e1',
      from: 'node2',
      to: 'gpu-0',
      type: 'hosts',
      discovered_at: '2026-01-01T00:00:00.000Z',
      last_seen: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    const n = descriptor.nodes[0]!;
    expect(n.capability_tags).toContain('gpu');
  });

  test('collects hosted_service_roles from connected service entities', async () => {
    await graphStore.upsertEntity(makeEntity({ id: 'node3', kind: 'node' }));
    await graphStore.upsertEntity(
      makeEntity({ id: 'svc-plex', kind: 'service', attributes: { role: 'media' } }),
    );
    await graphStore.upsertEdge({
      id: 'e2',
      from: 'svc-plex',
      to: 'node3',
      type: 'runs-on',
      discovered_at: '2026-01-01T00:00:00.000Z',
      last_seen: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    const n = descriptor.nodes[0]!;
    expect(n.hosted_service_roles).toContain('media');
  });

  test('output is sorted by entity id', async () => {
    await graphStore.upsertEntity(makeEntity({ id: 'z-node', kind: 'node' }));
    await graphStore.upsertEntity(makeEntity({ id: 'a-node', kind: 'node' }));
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    expect(descriptor.nodes.map((n) => n.id)).toEqual(['a-node', 'z-node']);
  });

  test('Unraid platform_type → storage role + array + storage tags', async () => {
    await graphStore.upsertEntity(
      makeEntity({
        id: 'unraid-box',
        kind: 'platform',
        attributes: { platform_type: 'unraid', array_state: 'STARTED' },
      }),
    );
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    const n = descriptor.nodes[0]!;
    expect(n.role).toBe('storage');
    expect(n.capability_tags).toContain('array');
    // array tag cascades to storage tag (the array IS the storage device).
    expect(n.capability_tags).toContain('storage');
    expect(n.env_tier).toBe('prod');
  });

  test('invariant #62: no node name or id appears in derived tags/role/env', async () => {
    // Use deliberately unusual names to verify the derivation logic
    // never inspects the name/id string.
    await graphStore.upsertEntity(
      makeEntity({
        id: 'gallifrey-lab-99',
        name: 'gallifrey-lab-99',
        kind: 'node',
        attributes: { manager_status: 'Leader' },
      }),
    );
    const analyzer = new TopologyAnalyzer(graphStore);
    const descriptor = await analyzer.analyze();
    const n = descriptor.nodes[0]!;
    // Tags, role, and env_tier must be derived from attributes only,
    // not from the entity id or name.
    expect(n.capability_tags).toContain('manager');
    expect(n.role).toBe('manager');
    expect(n.env_tier).toBe('infra');
  });
});
