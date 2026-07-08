/**
 * Tests for RefreshEngine — issue #31.
 *
 * Covers all acceptance criteria with no live network access:
 *  1. Sweep upserts entities and refreshes last_seen via deep enumeration.
 *  2. Entity absent from a second sweep goes stale then gone (two sweeps).
 *  3. Unreachable platform produces failed summary but does NOT trigger gone
 *     transitions for its entities (no-op protection).
 *  4. Replica drop detected as a DriftEvent and emitted as an observation.
 *  5. Image change detected as a DriftEvent and emitted as an observation.
 *  6. New entity (added in second sweep) appears as entity_added drift event.
 *  7. Gone entity emits an entity_gone observation with correct dedup key.
 *  8. Dedup cache suppresses re-emission of the same drift within the window.
 *  9. Diff is computed correctly across the full set of events.
 *
 * Invariant #62: assertions are structural only. No homelab-specific names.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { RefreshEngine } from '../../src/discovery/refresh';
import type { SweepResult, DriftEvent } from '../../src/discovery/refresh';
import { GraphStore } from '../../src/discovery/graph-store';
import { ObservationStore } from '../../src/observation/persistence';
import { DedupCache } from '../../src/observation/dedup';
import { fileMutex } from '../../src/util/file-mutex';
import type { Entity, Edge } from '../../src/discovery/graph-types';
import type { DeepEnumerator, DeepEnumerationResult } from '../../src/discovery/deep-enumerator';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const T0 = '2026-06-01T00:00:00.000Z';
const T1 = '2026-06-01T00:06:00.000Z'; // 6 min after T0 — past stale threshold (5 min)
const T2 = '2026-06-01T00:35:00.000Z'; // 35 min after T0 — past gone threshold (30 min)

const PLATFORM_ID = 'test-platform-a';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? 'svc-alpha',
    kind: overrides.kind ?? 'service',
    name: overrides.name ?? 'alpha',
    attributes: overrides.attributes ?? {},
    source: overrides.source ?? 'test',
    platformId: overrides.platformId ?? PLATFORM_ID,
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
    type: overrides.type ?? 'runs-on',
    discovered_at: overrides.discovered_at ?? T0,
    last_seen: overrides.last_seen ?? T0,
    status: overrides.status ?? 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a mock DeepEnumerator that returns a fixed result and optionally
 * records the options it was called with.
 */
function makeMockEnumerator(
  result: DeepEnumerationResult,
  calls: Array<Parameters<DeepEnumerator['enumerate']>[0]> = [],
): DeepEnumerator {
  return {
    enumerate: jest.fn().mockImplementation(
      async (opts: Parameters<DeepEnumerator['enumerate']>[0]) => {
        calls.push(opts);
        return result;
      },
    ),
  } as unknown as DeepEnumerator;
}

/** Build a mock DeepEnumerator that upserts the given entities/edges into the store. */
function makeMockEnumeratorWithUpsert(
  graphStore: GraphStore,
  entities: Entity[],
  edges: Edge[],
  platformId: string,
  now: string,
): DeepEnumerator {
  return {
    enumerate: jest.fn().mockImplementation(async () => {
      for (const e of entities) {
        await graphStore.upsertEntity({ ...e, last_seen: now });
      }
      for (const edge of edges) {
        await graphStore.upsertEdge({ ...edge, last_seen: now });
      }
      return {
        summaries: [
          { platformId, platformKind: 'test', ok: true, entitiesUpserted: entities.length, edgesUpserted: edges.length },
        ],
        totalEntities: entities.length,
        totalEdges: edges.length,
      } satisfies DeepEnumerationResult;
    }),
  } as unknown as DeepEnumerator;
}

/** Build an isolated GraphStore (separate mutex avoids cross-test contention). */
function makeStore(p: string): GraphStore {
  return new GraphStore(p, { mutex: fileMutex() });
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let graphPath: string;
let obsDir: string;

beforeEach(async () => {
  tempDir = await mkTempDir('adh-refresh-test-');
  graphPath = path.join(tempDir, 'inventory-graph.yaml');
  obsDir = tempDir;
});

afterEach(async () => {
  await rmTempDir(tempDir);
});

// ---------------------------------------------------------------------------
// 1. Upsert + last_seen refresh
// ---------------------------------------------------------------------------

describe('RefreshEngine: upsert semantics', () => {
  it('sweep upserts entities and refreshes last_seen to sweepAt', async () => {
    const entity = makeEntity({ id: 'svc-1', last_seen: T0 });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const enumerator = makeMockEnumeratorWithUpsert(
      graphStore,
      [{ ...entity, last_seen: T1 }],
      [],
      PLATFORM_ID,
      T1,
    );
    const store = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, store, dedup, {
      clock: () => T1,
    });

    await engine.sweep();

    const updated = await graphStore.getEntity('svc-1');
    expect(updated).not.toBeNull();
    expect(updated!.last_seen).toBe(T1);
    expect(updated!.status).toBe('active');
  });

  it('sweep reports entitiesUpserted and edgesUpserted from enumeration', async () => {
    const entity = makeEntity({ id: 'svc-2' });
    const edge = makeEdge({ id: 'edge-1' });
    const graphStore = makeStore(graphPath);

    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [entity], [edge], PLATFORM_ID, T0);
    const store = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, store, dedup, { clock: () => T0 });
    const result = await engine.sweep();

    expect(result.entitiesUpserted).toBe(1);
    expect(result.edgesUpserted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Staleness + gone transitions
// ---------------------------------------------------------------------------

describe('RefreshEngine: staleness/gone transitions', () => {
  it('entity unseen for >stalenessThreshold is marked stale', async () => {
    // Seed: entity with last_seen = T0.
    const entity = makeEntity({ id: 'svc-stale', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    // Sweep at T1 (6 min later) without re-upserting the entity (simulates absence).
    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T1);
    const store = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, store, dedup, {
      clock: () => T1,
      thresholds: {
        stalenessThresholdMs: 5 * 60_000,  // 5 min
        goneThresholdMs: 30 * 60_000,       // 30 min
      },
    });

    const result = await engine.sweep();

    const updated = await graphStore.getEntity('svc-stale');
    expect(updated!.status).toBe('stale');
    expect(result.markedStale).toBe(1);
    expect(result.markedGone).toBe(0);
  });

  it('entity unseen for >goneThreshold is marked gone', async () => {
    const entity = makeEntity({ id: 'svc-gone', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    // Sweep at T2 (35 min later).
    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T2);
    const store = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, store, dedup, {
      clock: () => T2,
      thresholds: {
        stalenessThresholdMs: 5 * 60_000,
        goneThresholdMs: 30 * 60_000,
      },
    });

    const result = await engine.sweep();

    const updated = await graphStore.getEntity('svc-gone');
    expect(updated!.status).toBe('gone');
    expect(result.markedGone).toBe(1);
  });

  it('entity absent across two sweeps: active → stale → gone (two sweeps)', async () => {
    const entity = makeEntity({ id: 'svc-lifecycle', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const store = new ObservationStore(obsDir);

    // Sweep 1 at T1 (6 min): entity not re-upserted → becomes stale.
    const engine1 = new RefreshEngine(
      makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T1),
      graphStore,
      store,
      new DedupCache(),
      { clock: () => T1, thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 } },
    );
    await engine1.sweep();
    expect((await graphStore.getEntity('svc-lifecycle'))!.status).toBe('stale');

    // Sweep 2 at T2 (35 min): still not re-upserted → becomes gone.
    const engine2 = new RefreshEngine(
      makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T2),
      graphStore,
      store,
      new DedupCache(),
      { clock: () => T2, thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 } },
    );
    await engine2.sweep();
    expect((await graphStore.getEntity('svc-lifecycle'))!.status).toBe('gone');
  });

  it('gone entity is never hard-deleted (history preserved)', async () => {
    const entity = makeEntity({ id: 'svc-history', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const engine = new RefreshEngine(
      makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T2),
      graphStore,
      new ObservationStore(obsDir),
      new DedupCache(),
      { clock: () => T2, thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 } },
    );
    await engine.sweep();

    // Entity still exists in the graph as 'gone'.
    const all = await graphStore.all();
    const found = all.entities.find((e) => e.id === 'svc-history');
    expect(found).toBeDefined();
    expect(found!.status).toBe('gone');
  });
});

// ---------------------------------------------------------------------------
// 3. Unreachable platform: no-op (no mass-gone sweep)
// ---------------------------------------------------------------------------

describe('RefreshEngine: unreachable platform is a no-op', () => {
  it('entities of a failed platform are NOT marked stale/gone', async () => {
    // Seed an entity belonging to a platform that will fail.
    const entity = makeEntity({
      id: 'svc-unreachable',
      platformId: 'platform-bad',
      last_seen: T0,
      status: 'active',
    });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    // Enumerator reports the platform as failed (ok: false).
    const failingResult: DeepEnumerationResult = {
      summaries: [
        { platformId: 'platform-bad', platformKind: 'test', ok: false, entitiesUpserted: 0, edgesUpserted: 0, error: 'connection refused' },
      ],
      totalEntities: 0,
      totalEdges: 0,
    };
    const enumerator = makeMockEnumerator(failingResult);
    const store = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    // Sweep at T2 — if the entity's platform were considered succeeded, it would go 'gone'.
    const engine = new RefreshEngine(enumerator, graphStore, store, dedup, {
      clock: () => T2,
      thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 },
    });
    const result = await engine.sweep();

    // Entity must NOT have been transitioned.
    const updated = await graphStore.getEntity('svc-unreachable');
    expect(updated!.status).toBe('active');
    expect(result.markedStale).toBe(0);
    expect(result.markedGone).toBe(0);
    expect(result.platformsFailed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Drift: replica mismatch → observation
// ---------------------------------------------------------------------------

describe('RefreshEngine: replica mismatch drift', () => {
  it('emits replica_mismatch drift event when running < desired', async () => {
    const entity = makeEntity({
      id: 'svc-replicas',
      attributes: { replicas_running: 2, replicas_desired: 3 },
    });
    const graphStore = makeStore(graphPath);

    // Pre-seed prior state with full replicas.
    await graphStore.upsertEntity(makeEntity({ id: 'svc-replicas', attributes: { replicas_running: 3, replicas_desired: 3 } }));

    const enumerator = makeMockEnumeratorWithUpsert(
      graphStore,
      [entity],
      [],
      PLATFORM_ID,
      T1,
    );
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, {
      clock: () => T1,
    });
    const result = await engine.sweep();

    const replicaEvents = result.driftEvents.filter((e) => e.kind === 'replica_mismatch');
    expect(replicaEvents).toHaveLength(1);
    const evt = replicaEvents[0] as Extract<DriftEvent, { kind: 'replica_mismatch' }>;
    expect(evt.replicasRunning).toBe(2);
    expect(evt.replicasDesired).toBe(3);

    // An observation must have been emitted.
    expect(result.observationsEmitted).toBeGreaterThanOrEqual(1);

    // Verify the observation is on disk.
    const observations = await obsStore.list();
    const driftObs = observations.find((o) => o.pattern === 'replica_mismatch');
    expect(driftObs).toBeDefined();
    expect(driftObs!.resource).toBe(`service/${entity.id}`);
    expect(driftObs!.platform).toBe(PLATFORM_ID);
    expect(driftObs!.severity).toBe('P1');
    expect(driftObs!.details).toMatchObject({
      replicas_running: 2,
      replicas_desired: 3,
    });
  });

  it('does NOT emit replica_mismatch when running === desired', async () => {
    const entity = makeEntity({
      id: 'svc-ok-replicas',
      attributes: { replicas_running: 3, replicas_desired: 3 },
    });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [entity], [], PLATFORM_ID, T1);
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, { clock: () => T1 });
    const result = await engine.sweep();

    const replicaEvents = result.driftEvents.filter((e) => e.kind === 'replica_mismatch');
    expect(replicaEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Drift: image changed → observation
// ---------------------------------------------------------------------------

describe('RefreshEngine: image change drift', () => {
  it('emits image_changed drift event when image attribute changes', async () => {
    const priorEntity = makeEntity({
      id: 'svc-img',
      attributes: { image: 'nginx:1.24' },
      last_seen: T0,
    });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(priorEntity);

    // Next sweep: image bumped.
    const updatedEntity = makeEntity({
      id: 'svc-img',
      attributes: { image: 'nginx:1.25' },
      last_seen: T1,
    });
    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [updatedEntity], [], PLATFORM_ID, T1);
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, { clock: () => T1 });
    const result = await engine.sweep();

    const imgEvents = result.driftEvents.filter((e) => e.kind === 'image_changed');
    expect(imgEvents).toHaveLength(1);
    const evt = imgEvents[0] as Extract<DriftEvent, { kind: 'image_changed' }>;
    expect(evt.previousImage).toBe('nginx:1.24');
    expect(evt.currentImage).toBe('nginx:1.25');

    // Observation emitted.
    expect(result.observationsEmitted).toBeGreaterThanOrEqual(1);
    const observations = await obsStore.list();
    const obs = observations.find((o) => o.pattern === 'image_changed');
    expect(obs).toBeDefined();
    expect(obs!.details).toMatchObject({ previous_image: 'nginx:1.24', current_image: 'nginx:1.25' });
    expect(obs!.severity).toBe('P2');
  });

  it('does NOT emit image_changed when image is unchanged', async () => {
    const entity = makeEntity({ id: 'svc-stable-img', attributes: { image: 'nginx:1.24' } });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [entity], [], PLATFORM_ID, T1);
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, { clock: () => T1 });
    const result = await engine.sweep();

    expect(result.driftEvents.filter((e) => e.kind === 'image_changed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Drift: entity added
// ---------------------------------------------------------------------------

describe('RefreshEngine: entity_added drift', () => {
  it('emits entity_added drift event for brand-new entities', async () => {
    const graphStore = makeStore(graphPath);
    // Graph starts empty.
    const newEntity = makeEntity({ id: 'svc-brand-new' });

    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [newEntity], [], PLATFORM_ID, T0);
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, { clock: () => T0 });
    const result = await engine.sweep();

    const addedEvents = result.driftEvents.filter((e) => e.kind === 'entity_added');
    expect(addedEvents).toHaveLength(1);
    expect(addedEvents[0]!.entity.id).toBe('svc-brand-new');
    // entity_added is informational — no observation is emitted.
    expect(result.observationsEmitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Gone entity emits entity_gone observation
// ---------------------------------------------------------------------------

describe('RefreshEngine: entity_gone observation', () => {
  it('emits entity_gone observation when entity transitions to gone', async () => {
    const entity = makeEntity({ id: 'svc-vanished', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    // Sweep at T2 with entity absent → goes gone.
    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T2);
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, {
      clock: () => T2,
      thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 },
    });
    const result = await engine.sweep();

    const goneEvents = result.driftEvents.filter((e) => e.kind === 'entity_gone');
    expect(goneEvents).toHaveLength(1);
    expect(goneEvents[0]!.entity.id).toBe('svc-vanished');

    const observations = await obsStore.list();
    const obs = observations.find((o) => o.pattern === 'entity_gone');
    expect(obs).toBeDefined();
    expect(obs!.resource).toBe(`service/${entity.id}`);
    expect(obs!.platform).toBe(PLATFORM_ID);
    expect(obs!.dedup_key).toBe(`${PLATFORM_ID}:entity_gone:service/${entity.id}`);
    expect(obs!.severity).toBe('P1');
    expect(result.observationsEmitted).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Dedup suppression
// ---------------------------------------------------------------------------

describe('RefreshEngine: dedup suppression', () => {
  it('does NOT re-emit an observation that is still within the dedup window', async () => {
    const entity = makeEntity({ id: 'svc-dedup', last_seen: T0, status: 'active' });
    const graphStore = makeStore(graphPath);
    await graphStore.upsertEntity(entity);

    const obsStore = new ObservationStore(obsDir);
    // Pre-populate the dedup cache with the key that would be emitted.
    const dedup = new DedupCache(3_600_000); // 1h window
    const preloadedObs = {
      id: 'pre-existing-obs-id',
      platform: PLATFORM_ID,
      pattern: 'entity_gone' as const,
      resource: `service/${entity.id}`,
      severity: 'P1' as const,
      discovered_at: T2,
      dedup_key: `${PLATFORM_ID}:entity_gone:service/${entity.id}`,
    };
    dedup.hydrate([preloadedObs], new Date(T2).getTime());

    const enumerator = makeMockEnumeratorWithUpsert(graphStore, [], [], PLATFORM_ID, T2);
    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, {
      clock: () => T2,
      thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 },
    });
    const result = await engine.sweep();

    // Drift event is still computed but observation should be suppressed by dedup.
    const goneEvents = result.driftEvents.filter((e) => e.kind === 'entity_gone');
    expect(goneEvents).toHaveLength(1);
    // The observation was suppressed.
    expect(result.observationsEmitted).toBe(0);
    const observations = await obsStore.list();
    expect(observations.filter((o) => o.pattern === 'entity_gone')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Diff correctness: multiple events in one sweep
// ---------------------------------------------------------------------------

describe('RefreshEngine: diff correctness', () => {
  it('computes all drift event kinds in a single sweep', async () => {
    const graphStore = makeStore(graphPath);

    // Prior state:
    //  - svc-gone-entity: will go gone (unseen for >30 min)
    //  - svc-replica-drop: will have replica mismatch
    //  - svc-image-bump: will have image change
    const priorGone = makeEntity({ id: 'svc-gone-entity', last_seen: T0, status: 'active' });
    const priorReplica = makeEntity({ id: 'svc-replica-drop', attributes: { replicas_running: 3, replicas_desired: 3 }, last_seen: T0 });
    const priorImage = makeEntity({ id: 'svc-image-bump', attributes: { image: 'app:v1' }, last_seen: T0 });

    await graphStore.upsertEntity(priorGone);
    await graphStore.upsertEntity(priorReplica);
    await graphStore.upsertEntity(priorImage);

    // This sweep: gone-entity absent; replica drop; image changed; new entity.
    const currentReplica = makeEntity({ id: 'svc-replica-drop', attributes: { replicas_running: 1, replicas_desired: 3 }, last_seen: T2 });
    const currentImage = makeEntity({ id: 'svc-image-bump', attributes: { image: 'app:v2' }, last_seen: T2 });
    const newEntity = makeEntity({ id: 'svc-brand-new-b' });

    const enumerator = makeMockEnumeratorWithUpsert(
      graphStore,
      [currentReplica, currentImage, newEntity],
      [],
      PLATFORM_ID,
      T2,
    );
    const obsStore = new ObservationStore(obsDir);
    const dedup = new DedupCache();

    const engine = new RefreshEngine(enumerator, graphStore, obsStore, dedup, {
      clock: () => T2,
      thresholds: { stalenessThresholdMs: 5 * 60_000, goneThresholdMs: 30 * 60_000 },
    });
    const result = await engine.sweep();

    const kinds = result.driftEvents.map((e) => e.kind);
    expect(kinds).toContain('entity_gone');
    expect(kinds).toContain('replica_mismatch');
    expect(kinds).toContain('image_changed');
    expect(kinds).toContain('entity_added');

    // 3 material events emit observations (entity_added does not).
    expect(result.observationsEmitted).toBe(3);
  });

  it('platformFilter is forwarded to the DeepEnumerator', async () => {
    const graphStore = makeStore(graphPath);
    const calls: Array<Parameters<DeepEnumerator['enumerate']>[0]> = [];
    const enumerator = makeMockEnumerator(
      { summaries: [], totalEntities: 0, totalEdges: 0 },
      calls,
    );
    const engine = new RefreshEngine(
      enumerator,
      graphStore,
      new ObservationStore(obsDir),
      new DedupCache(),
      { clock: () => T0 },
    );

    await engine.sweep({ platformFilter: ['p-only'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ platformFilter: ['p-only'] });
  });
});

// ---------------------------------------------------------------------------
// 10. SweepResult shape
// ---------------------------------------------------------------------------

describe('RefreshEngine: SweepResult shape', () => {
  it('returns sweepAt equal to the clock value', async () => {
    const graphStore = makeStore(graphPath);
    const enumerator = makeMockEnumerator({ summaries: [], totalEntities: 0, totalEdges: 0 });
    const engine = new RefreshEngine(
      enumerator,
      graphStore,
      new ObservationStore(obsDir),
      new DedupCache(),
      { clock: () => T0 },
    );
    const result: SweepResult = await engine.sweep();
    expect(result.sweepAt).toBe(T0);
  });

  it('returns platformsFailed count from enumeration summaries', async () => {
    const graphStore = makeStore(graphPath);
    const failResult: DeepEnumerationResult = {
      summaries: [
        { platformId: 'p1', platformKind: 'test', ok: true, entitiesUpserted: 0, edgesUpserted: 0 },
        { platformId: 'p2', platformKind: 'test', ok: false, entitiesUpserted: 0, edgesUpserted: 0, error: 'down' },
      ],
      totalEntities: 0,
      totalEdges: 0,
    };
    const enumerator = makeMockEnumerator(failResult);
    const engine = new RefreshEngine(
      enumerator,
      graphStore,
      new ObservationStore(obsDir),
      new DedupCache(),
      { clock: () => T0 },
    );
    const result = await engine.sweep();
    expect(result.platformsFailed).toBe(1);
  });
});
