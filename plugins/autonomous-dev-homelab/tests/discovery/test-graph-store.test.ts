/**
 * GraphStore unit tests — issue #26.
 *
 * Covers:
 *   - entity/edge upsert + merge (last_seen refresh)
 *   - persistence round-trip (write → reload)
 *   - query API (entitiesByKind, neighbors, edgesOf, all)
 *   - schema validation accepts unknown kinds and edge types (invariant #62)
 *   - platform→entities bridge (platformToEntities)
 *   - GraphStoreError shape
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';
import { GraphStore, GraphStoreError } from '../../src/discovery/graph-store';
import type { Entity, Edge } from '../../src/discovery/graph-types';
import { KNOWN_KINDS, KNOWN_EDGE_TYPES } from '../../src/discovery/graph-types';
import { platformToEntities } from '../../src/discovery/graph-bridge';
import type { Platform } from '../../src/discovery/inventory-types';
import { fileMutex } from '../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = '2026-06-01T00:00:00.000Z';
const T1 = '2026-06-02T00:00:00.000Z';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? 'svc-alpha',
    kind: overrides.kind ?? KNOWN_KINDS.service,
    name: overrides.name ?? 'alpha',
    attributes: overrides.attributes ?? {},
    source: overrides.source ?? 'test',
    discovered_at: overrides.discovered_at ?? T0,
    last_seen: overrides.last_seen ?? T0,
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

function makeEdge(overrides: Partial<Edge> = {}): Edge {
  return {
    id: overrides.id ?? 'edge-alpha-node',
    from: overrides.from ?? 'svc-alpha',
    to: overrides.to ?? 'node-01',
    type: overrides.type ?? KNOWN_EDGE_TYPES['runs-on'],
    discovered_at: overrides.discovered_at ?? T0,
    last_seen: overrides.last_seen ?? T0,
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: overrides.id ?? 'proxmox-ve-10-0-0-1',
    type: overrides.type ?? 'proxmox-ve',
    host: overrides.host ?? '10.0.0.1',
    port: overrides.port ?? 8006,
    discovered_at: overrides.discovered_at ?? T0,
    last_seen: overrides.last_seen ?? T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(graphPath: string): GraphStore {
  // Isolated mutex per store so tests don't contend with each other.
  return new GraphStore(graphPath, { mutex: fileMutex() });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GraphStore', () => {
  let tempDir: string;
  let graphPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('adh-graph-test-');
    graphPath = path.join(tempDir, 'inventory-graph.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  // ---- missing file returns empty graph ------------------------------------

  test('returns empty graph when file is absent', async () => {
    const store = makeStore(graphPath);
    const doc = await store.all();
    expect(doc.version).toBe(2);
    expect(doc.entities).toHaveLength(0);
    expect(doc.edges).toHaveLength(0);
  });

  // ---- upsertEntity --------------------------------------------------------

  test('upsertEntity inserts a new entity and persists it', async () => {
    const store = makeStore(graphPath);
    const entity = makeEntity();
    await store.upsertEntity(entity);

    const found = await store.getEntity(entity.id);
    expect(found).toEqual(entity);
  });

  test('upsertEntity merges over existing entity and refreshes last_seen', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity({ last_seen: T0 }));

    const updated = makeEntity({ last_seen: T1, attributes: { version: '2.0' } });
    await store.upsertEntity(updated);

    const found = await store.getEntity('svc-alpha');
    expect(found).not.toBeNull();
    expect(found!.last_seen).toBe(T1);
    expect(found!.attributes).toEqual({ version: '2.0' });
  });

  test('persistence round-trip: write then reload in a fresh store', async () => {
    const store1 = makeStore(graphPath);
    await store1.upsertEntity(makeEntity({ id: 'e1', kind: 'service', name: 'svc-1' }));
    await store1.upsertEntity(makeEntity({ id: 'e2', kind: 'node', name: 'host-1' }));

    const store2 = makeStore(graphPath);
    const doc = await store2.all();
    expect(doc.entities).toHaveLength(2);
    expect(doc.entities.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  // ---- upsertEdge ----------------------------------------------------------

  test('upsertEdge inserts a new edge and persists it', async () => {
    const store = makeStore(graphPath);
    const edge = makeEdge();
    await store.upsertEdge(edge);

    const edges = await store.edgesOf('svc-alpha');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.id).toBe(edge.id);
  });

  test('upsertEdge merges over existing edge and refreshes last_seen', async () => {
    const store = makeStore(graphPath);
    await store.upsertEdge(makeEdge({ last_seen: T0 }));
    await store.upsertEdge(makeEdge({ last_seen: T1, attributes: { weight: 5 } }));

    const edges = await store.edgesOf('svc-alpha');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.last_seen).toBe(T1);
    expect(edges[0]!.attributes).toEqual({ weight: 5 });
  });

  // ---- entitiesByKind ------------------------------------------------------

  test('entitiesByKind filters correctly', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity({ id: 'n1', kind: 'node', name: 'host-a' }));
    await store.upsertEntity(makeEntity({ id: 's1', kind: 'service', name: 'svc-a' }));
    await store.upsertEntity(makeEntity({ id: 's2', kind: 'service', name: 'svc-b' }));

    const nodes = await store.entitiesByKind('node');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe('n1');

    const services = await store.entitiesByKind('service');
    expect(services).toHaveLength(2);
  });

  // ---- neighbors / edgesOf -------------------------------------------------

  test('neighbors returns connected entities in both directions', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity({ id: 'A', kind: 'service', name: 'a' }));
    await store.upsertEntity(makeEntity({ id: 'B', kind: 'node', name: 'b' }));
    await store.upsertEntity(makeEntity({ id: 'C', kind: 'container', name: 'c' }));
    await store.upsertEdge(makeEdge({ id: 'e-AB', from: 'A', to: 'B', type: 'runs-on' }));
    await store.upsertEdge(makeEdge({ id: 'e-CA', from: 'C', to: 'A', type: 'depends-on' }));

    const neighborsOfA = await store.neighbors('A');
    const ids = neighborsOfA.map((e) => e.id).sort();
    expect(ids).toEqual(['B', 'C']);
  });

  test('neighbors filters by edgeType', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity({ id: 'A', kind: 'service', name: 'a' }));
    await store.upsertEntity(makeEntity({ id: 'B', kind: 'node', name: 'b' }));
    await store.upsertEntity(makeEntity({ id: 'C', kind: 'container', name: 'c' }));
    await store.upsertEdge(makeEdge({ id: 'e-AB', from: 'A', to: 'B', type: 'runs-on' }));
    await store.upsertEdge(makeEdge({ id: 'e-AC', from: 'A', to: 'C', type: 'hosts' }));

    const runOnNeighbors = await store.neighbors('A', 'runs-on');
    expect(runOnNeighbors.map((e) => e.id)).toEqual(['B']);
  });

  test('edgesOf filters by edgeType', async () => {
    const store = makeStore(graphPath);
    await store.upsertEdge(makeEdge({ id: 'e1', from: 'X', to: 'Y', type: 'runs-on' }));
    await store.upsertEdge(makeEdge({ id: 'e2', from: 'X', to: 'Z', type: 'hosts' }));

    const runOn = await store.edgesOf('X', 'runs-on');
    expect(runOn).toHaveLength(1);
    expect(runOn[0]!.id).toBe('e1');

    const all = await store.edgesOf('X');
    expect(all).toHaveLength(2);
  });

  // ---- unknown kind/type (dynamic-first invariant #62) --------------------

  test('unknown kind upserts, persists, reloads, and queries fine', async () => {
    const store1 = makeStore(graphPath);
    const exotic = makeEntity({ id: 'exotic-1', kind: 'quantum-oscillator', name: 'q1' });
    await store1.upsertEntity(exotic);

    const store2 = makeStore(graphPath);
    const byKind = await store2.entitiesByKind('quantum-oscillator');
    expect(byKind).toHaveLength(1);
    expect(byKind[0]!.id).toBe('exotic-1');
    expect(byKind[0]!.kind).toBe('quantum-oscillator');
  });

  test('unknown edge type upserts, persists, reloads, and queries fine', async () => {
    const store1 = makeStore(graphPath);
    await store1.upsertEdge(makeEdge({ id: 'e-unknown', type: 'teleports-to' }));

    const store2 = makeStore(graphPath);
    const edges = await store2.edgesOf('svc-alpha', 'teleports-to');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.type).toBe('teleports-to');
  });

  // ---- schema validation ---------------------------------------------------

  test('schema rejects corrupt YAML', async () => {
    await fs.writeFile(graphPath, '{not valid yaml ::: corrupt', 'utf8');
    const store = makeStore(graphPath);
    await expect(store.all()).rejects.toMatchObject({ code: 'INVALID_GRAPH' });
  });

  test('schema rejects wrong version number', async () => {
    const bad = { version: 99, entities: [], edges: [] };
    await fs.writeFile(graphPath, yaml.dump(bad), 'utf8');
    const store = makeStore(graphPath);
    await expect(store.all()).rejects.toMatchObject({ code: 'INVALID_GRAPH' });
  });

  test('schema accepts unknown kind strings without error', async () => {
    const store = makeStore(graphPath);
    const entity = makeEntity({ id: 'new-kind-1', kind: 'brand-new-kind-never-seen-before' });
    await expect(store.upsertEntity(entity)).resolves.toBeUndefined();
    const found = await store.getEntity('new-kind-1');
    expect(found).not.toBeNull();
    expect(found!.kind).toBe('brand-new-kind-never-seen-before');
  });

  // ---- persistence file properties ----------------------------------------

  test('graph file is written with mode 0600', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity());
    const stat = await fs.stat(graphPath);
    // stat.mode & 0o777 gives rwxrwxrwx bits; 0600 = rw-------
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('graph file is valid YAML with version:2 structure', async () => {
    const store = makeStore(graphPath);
    await store.upsertEntity(makeEntity({ id: 'e-yaml', kind: 'service', name: 'svc' }));
    const raw = await fs.readFile(graphPath, 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed['version']).toBe(2);
    expect(Array.isArray(parsed['entities'])).toBe(true);
    expect(Array.isArray(parsed['edges'])).toBe(true);
  });

  // ---- concurrency (mutex) -------------------------------------------------

  test('50 concurrent upsertEntity calls serialize correctly', async () => {
    const store = makeStore(graphPath);
    const ops = Array.from({ length: 50 }, (_, i) =>
      store.upsertEntity(makeEntity({ id: `entity-${i}`, kind: 'service', name: `svc-${i}` })),
    );
    await Promise.all(ops);
    const doc = await store.all();
    expect(doc.entities).toHaveLength(50);
    expect(new Set(doc.entities.map((e) => e.id)).size).toBe(50);
  }, 30_000);

  // ---- GraphStoreError shape -----------------------------------------------

  test('GraphStoreError is an Error with stable code', () => {
    const e = new GraphStoreError('INVALID_GRAPH', 'test');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('INVALID_GRAPH');
    expect(e.name).toBe('GraphStoreError');
  });
});

// ---------------------------------------------------------------------------
// platformToEntities bridge
// ---------------------------------------------------------------------------

describe('platformToEntities bridge', () => {
  test('returns two entities and one edge from a minimal platform', () => {
    const p = makePlatform();
    const { entities, edges } = platformToEntities(p);

    expect(entities).toHaveLength(2);
    expect(edges).toHaveLength(1);

    const [platformEnt, nodeEnt] = entities;
    expect(platformEnt!.kind).toBe(KNOWN_KINDS.platform);
    expect(platformEnt!.id).toBe(`platform:${p.id}`);
    expect(platformEnt!.platformId).toBe(p.id);
    expect(platformEnt!.attributes['type']).toBe(p.type);
    expect(platformEnt!.attributes['host']).toBe(p.host);

    expect(nodeEnt!.kind).toBe(KNOWN_KINDS.node);
    expect(nodeEnt!.id).toBe(`node:${p.host}`);
    expect(nodeEnt!.attributes['host']).toBe(p.host);

    const [edge] = edges;
    expect(edge!.type).toBe(KNOWN_EDGE_TYPES['runs-on']);
    expect(edge!.from).toBe(platformEnt!.id);
    expect(edge!.to).toBe(nodeEnt!.id);
  });

  test('entity ids are deterministic (stable across calls)', () => {
    const p = makePlatform({ id: 'unraid-01', host: '192.168.1.20' });
    const { entities: [pe1, ne1] } = platformToEntities(p);
    const { entities: [pe2, ne2] } = platformToEntities(p);
    expect(pe1!.id).toBe(pe2!.id);
    expect(ne1!.id).toBe(ne2!.id);
  });

  test('propagates ssh_host and metadata when present', () => {
    const p = makePlatform({
      ssh_host: '10.0.0.2',
      ssh_port: 22,
      metadata: { cluster_name: 'lab' },
    });
    const { entities: [platformEnt, nodeEnt] } = platformToEntities(p);
    expect(platformEnt!.attributes['ssh_host']).toBe('10.0.0.2');
    expect(platformEnt!.attributes['metadata']).toEqual({ cluster_name: 'lab' });
    expect(nodeEnt!.attributes['ssh_host']).toBe('10.0.0.2');
  });

  test('bridge entities upsert into GraphStore without error', async () => {
    const tempDir = await mkTempDir('adh-bridge-test-');
    const graphPath = path.join(tempDir, 'inventory-graph.yaml');
    const store = new GraphStore(graphPath, { mutex: fileMutex() });
    try {
      const p = makePlatform();
      const { entities, edges } = platformToEntities(p);
      for (const e of entities) await store.upsertEntity(e);
      for (const e of edges) await store.upsertEdge(e);

      const platforms = await store.entitiesByKind(KNOWN_KINDS.platform);
      expect(platforms).toHaveLength(1);
      const nodes = await store.entitiesByKind(KNOWN_KINDS.node);
      expect(nodes).toHaveLength(1);
      const edgesOf = await store.edgesOf(platforms[0]!.id);
      expect(edgesOf).toHaveLength(1);
      expect(edgesOf[0]!.type).toBe('runs-on');
    } finally {
      await rmTempDir(tempDir);
    }
  });
});
