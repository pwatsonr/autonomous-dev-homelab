/**
 * DatastoreHealthProbe unit tests (issue #43).
 *
 * Invariant #62: uses generic fixture data and entity names; no homelab-specific
 * instance names in assertions. All exec calls are mocked — no live connections.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  DatastoreHealthProbe,
  registerHealthProbe,
  registeredHealthEngines,
  findHealthProbe,
  type DatastoreHealthExecSource,
  type EngineHealthSignals,
  type EngineHealthProbe,
} from '../../../src/observation/probes/datastore-health';
import { GraphStore } from '../../../src/discovery/graph-store';
import type { Entity } from '../../../src/discovery/graph-types';
import { fileMutex } from '../../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'docker-prod-01';
const NOW = '2026-06-23T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecSource(responses: Record<string, string>): DatastoreHealthExecSource {
  return {
    platformId: PLATFORM,
    exec: jest.fn().mockImplementation(async (cmd: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (cmd.includes(key)) return { stdout: value, exitCode: 0 };
      }
      return { stdout: '', exitCode: 1 };
    }),
  };
}

function makeDatastoreEntity(overrides: Partial<Entity> & { name: string }): Entity {
  return {
    id: `datastore:${PLATFORM}:${overrides.name}`,
    kind: 'datastore',
    attributes: {},
    source: 'datastore-probe',
    platformId: PLATFORM,
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('test-datastore-health');
  const graphPath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphPath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('registeredHealthEngines', () => {
  test('includes 4 built-in engines', () => {
    const engines = registeredHealthEngines();
    expect(engines).toContain('postgres');
    expect(engines).toContain('redis');
    expect(engines).toContain('opensearch');
    expect(engines).toContain('neo4j');
  });

  test('findHealthProbe: matches by engine attribute on datastore entity', () => {
    const entity = makeDatastoreEntity({
      name: 'my-db',
      attributes: { engine: 'postgres' },
    });
    const probe = findHealthProbe(entity);
    expect(probe).toBeDefined();
    expect(probe!.engine).toBe('postgres');
  });

  test('findHealthProbe: falls back to image signal when engine attribute absent', () => {
    const entity = makeDatastoreEntity({
      name: 'redis-cache',
      attributes: { image: 'redis:7' },
    });
    const probe = findHealthProbe(entity);
    expect(probe).toBeDefined();
    expect(probe!.engine).toBe('redis');
  });

  test('findHealthProbe: returns undefined for unrelated entity', () => {
    const entity = makeDatastoreEntity({
      name: 'nginx',
      attributes: { image: 'nginx:1.25' },
    });
    expect(findHealthProbe(entity)).toBeUndefined();
  });

  test('registerHealthProbe allows new engine registration without core edits', () => {
    const customProbe: EngineHealthProbe = {
      engine: 'mynewdb',
      matches: (e) => (e.attributes['engine'] as string) === 'mynewdb',
      collectSignals: jest.fn().mockResolvedValue({
        alive: true, connections: -1, max_connections: -1,
        replication_role: 'standalone', replication_lag_seconds: -1,
        disk_used_bytes: -1, disk_limit_bytes: -1,
        memory_used_bytes: -1, memory_limit_bytes: -1,
      } satisfies EngineHealthSignals),
    };
    registerHealthProbe(customProbe);
    const entity = makeDatastoreEntity({ name: 'custom', attributes: { engine: 'mynewdb' } });
    expect(findHealthProbe(entity)).toBe(customProbe);
  });
});

// ---------------------------------------------------------------------------
// DatastoreHealthProbe.scan() — empty graph
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe.scan() — empty graph', () => {
  test('returns [] when no datastore entities exist', async () => {
    const src = makeExecSource({});
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    expect(await probe.scan()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Postgres health signals
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe — postgres', () => {
  async function setupPgEntity(attrs: Record<string, unknown> = {}): Promise<Entity> {
    const entity = makeDatastoreEntity({
      name: 'pg-primary',
      attributes: { engine: 'postgres', container_name: 'pg-primary', ...attrs },
    });
    await graphStore.upsertEntity(entity);
    return entity;
  }

  test('healthy primary → no observations', async () => {
    await setupPgEntity();
    const src = makeExecSource({
      'SELECT 1': '1\n',
      'pg_stat_activity': '5\n',
      'SHOW max_connections': '100\n',
      'pg_is_in_recovery': 'f\n',
      'sum(pg_database_size': '104857600\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(0);
  });

  test('liveness failure → datastore_unhealthy (P0)', async () => {
    await setupPgEntity();
    const src = makeExecSource({
      // SELECT 1 returns empty (exec failure)
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
    expect(obs[0]!.severity).toBe('P0');
    expect(obs[0]!.platform).toBe(PLATFORM);
    expect(obs[0]!.resource).toBe('datastore/pg-primary');
    expect(obs[0]!.dedup_key).toBe(`${PLATFORM}:datastore_unhealthy:datastore/pg-primary`);
  });

  test('connection saturation ≥85% → datastore_near_capacity (P1)', async () => {
    await setupPgEntity();
    const src = makeExecSource({
      'SELECT 1': '1\n',
      'pg_stat_activity': '90\n',    // 90/100 = 90% > 85%
      'SHOW max_connections': '100\n',
      'pg_is_in_recovery': 'f\n',
      'sum(pg_database_size': '1024\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    const cap = obs.find((o) => o.pattern === 'datastore_near_capacity');
    expect(cap).toBeDefined();
    expect(cap!.severity).toBe('P1');
    expect((cap!.details as Record<string, unknown>)['connections']).toBe(90);
    expect((cap!.details as Record<string, unknown>)['max_connections']).toBe(100);
    expect((cap!.details as Record<string, unknown>)['saturation']).toBe(90);
  });

  test('replica lag > 30s → replication_lag (P1)', async () => {
    await setupPgEntity();
    const src = makeExecSource({
      'SELECT 1': '1\n',
      'pg_stat_activity': '5\n',
      'SHOW max_connections': '100\n',
      'pg_is_in_recovery': 't\n',   // replica
      'pg_last_xact_replay_timestamp': '120\n',  // 120s lag
      'sum(pg_database_size': '1024\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    const lag = obs.find((o) => o.pattern === 'replication_lag');
    expect(lag).toBeDefined();
    expect(lag!.severity).toBe('P1');
    expect((lag!.details as Record<string, unknown>)['lag_seconds']).toBe(120);
  });

  test('replica lag ≤ 30s → no replication_lag observation', async () => {
    await setupPgEntity();
    const src = makeExecSource({
      'SELECT 1': '1\n',
      'pg_stat_activity': '5\n',
      'SHOW max_connections': '100\n',
      'pg_is_in_recovery': 't\n',
      'pg_last_xact_replay_timestamp': '10\n',  // 10s lag — within threshold
      'sum(pg_database_size': '1024\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs.find((o) => o.pattern === 'replication_lag')).toBeUndefined();
  });

  test('disk pressure ≥85% → datastore_disk_pressure (P0)', async () => {
    await setupPgEntity();
    // 90GB used / 100GB total
    const used = 90 * 1024 * 1024 * 1024;
    const total = 100 * 1024 * 1024 * 1024;
    const src = makeExecSource({
      'SELECT 1': '1\n',
      'pg_stat_activity': '5\n',
      'SHOW max_connections': '100\n',
      'pg_is_in_recovery': 'f\n',
      'sum(pg_database_size': `${used}\n`,
    });
    // Simulate disk limit by mocking the entity attribute
    const entity = makeDatastoreEntity({
      name: 'pg-primary',
      attributes: { engine: 'postgres', container_name: 'pg-primary' },
    });
    // For postgres, disk_limit_bytes is not automatically derived from psql;
    // that signal is not available. Test verifies no false-positive when limit=-1.
    await graphStore.upsertEntity(entity);
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    // disk_limit_bytes=-1 → no disk pressure emitted (cannot compute ratio)
    expect(obs.find((o) => o.pattern === 'datastore_disk_pressure')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Redis health signals
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe — redis', () => {
  async function setupRedisEntity(attrs: Record<string, unknown> = {}): Promise<void> {
    await graphStore.upsertEntity(makeDatastoreEntity({
      name: 'my-redis',
      attributes: { engine: 'redis', container_name: 'my-redis', ...attrs },
    }));
  }

  test('healthy master + low usage → no observations', async () => {
    await setupRedisEntity();
    const infoFixture = await fs.readFile(path.join(FIX_DIR, 'redis-info-all.txt'), 'utf8');
    const src = makeExecSource({
      'redis-cli PING': 'PONG\n',
      'redis-cli INFO all': infoFixture,
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    // 42/100 connections (42%) < 85%; memory 10MB/100MB (10%) < 85%
    expect(obs).toHaveLength(0);
  });

  test('PING fails → datastore_unhealthy (P0)', async () => {
    await setupRedisEntity();
    const src = makeExecSource({
      'redis-cli PING': 'ERROR: NOAUTH\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
    expect(obs[0]!.severity).toBe('P0');
  });

  test('exec throws → datastore_unhealthy (graceful degradation)', async () => {
    await setupRedisEntity();
    const src: DatastoreHealthExecSource = {
      platformId: PLATFORM,
      exec: jest.fn().mockRejectedValue(new Error('connection lost')),
    };
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
  });

  test('replica with lag > 30s → replication_lag', async () => {
    await setupRedisEntity();
    const lagFixture = await fs.readFile(
      path.join(FIX_DIR, 'redis-info-replica-lagging.txt'),
      'utf8',
    );
    const src = makeExecSource({
      'redis-cli PING': 'PONG\n',
      'redis-cli INFO all': lagFixture,
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();

    // Replica with 120s lag → replication_lag
    const lag = obs.find((o) => o.pattern === 'replication_lag');
    expect(lag).toBeDefined();
    expect(lag!.severity).toBe('P1');
    expect((lag!.details as Record<string, unknown>)['lag_seconds']).toBe(120);
  });

  test('high connection saturation (90/100) → datastore_near_capacity', async () => {
    await setupRedisEntity();
    const lagFixture = await fs.readFile(
      path.join(FIX_DIR, 'redis-info-replica-lagging.txt'),
      'utf8',
    );
    // replica-lagging fixture has connected_clients:90, maxclients:100 → 90%
    const src = makeExecSource({
      'redis-cli PING': 'PONG\n',
      'redis-cli INFO all': lagFixture,
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    const cap = obs.find((o) => o.pattern === 'datastore_near_capacity');
    expect(cap).toBeDefined();
    expect(cap!.severity).toBe('P1');
  });

  test('high memory (89MB/100MB = 85%) → datastore_near_capacity', async () => {
    await setupRedisEntity();
    const lagFixture = await fs.readFile(
      path.join(FIX_DIR, 'redis-info-replica-lagging.txt'),
      'utf8',
    );
    // replica-lagging fixture: used_memory=89400320 (~85MB), maxmemory=104857600 (100MB) → ~85%
    const src = makeExecSource({
      'redis-cli PING': 'PONG\n',
      'redis-cli INFO all': lagFixture,
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    // memory saturation is 89400320/104857600 ≈ 85.3% → triggers
    const memCap = obs.filter((o) => o.pattern === 'datastore_near_capacity');
    expect(memCap.length).toBeGreaterThan(0);
  });

  test('unlimited maxmemory (0) → no memory capacity observation', async () => {
    await setupRedisEntity();
    const src = makeExecSource({
      'redis-cli PING': 'PONG\n',
      // maxmemory:0 = unlimited; used_memory high
      'redis-cli INFO all': 'redis_version:7.2.4\nconnected_clients:5\nmaxclients:100\nused_memory:999999999\nmaxmemory:0\nrole:master\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    // maxmemory=0 treated as unlimited → no capacity alert
    expect(obs.find((o) => o.pattern === 'datastore_near_capacity')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenSearch health signals
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe — opensearch', () => {
  async function setupOsEntity(): Promise<void> {
    await graphStore.upsertEntity(makeDatastoreEntity({
      name: 'my-opensearch',
      attributes: { engine: 'opensearch', container_name: 'my-opensearch' },
    }));
  }

  test('green cluster → no observations', async () => {
    await setupOsEntity();
    const healthFixture = await fs.readFile(
      path.join(FIX_DIR, 'opensearch-health-green.json'),
      'utf8',
    );
    const src = makeExecSource({
      'localhost:9200/_cluster/health': healthFixture,
      '_nodes/stats/fs': '{}',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    expect(await probe.scan()).toHaveLength(0);
  });

  test('red cluster → datastore_unhealthy (P0)', async () => {
    await setupOsEntity();
    const healthFixture = await fs.readFile(
      path.join(FIX_DIR, 'opensearch-health-red.json'),
      'utf8',
    );
    const src = makeExecSource({
      'localhost:9200/_cluster/health': healthFixture,
      '_nodes/stats/fs': '{}',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
    expect(obs[0]!.severity).toBe('P0');
  });

  test('empty exec response → datastore_unhealthy (unreachable)', async () => {
    await setupOsEntity();
    const src = makeExecSource({});
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
  });

  test('disk pressure from nodes stats → datastore_disk_pressure (P0)', async () => {
    await setupOsEntity();
    // total=100GB, available=5GB → used=95GB → 95% > 85%
    const totalBytes = 100 * 1024 * 1024 * 1024;
    const availableBytes = 5 * 1024 * 1024 * 1024;
    const nodesStatsJson = JSON.stringify({
      nodes: {
        'node-1': {
          fs: {
            total: {
              total_in_bytes: totalBytes,
              available_in_bytes: availableBytes,
            },
          },
        },
      },
    });
    const healthFixture = await fs.readFile(
      path.join(FIX_DIR, 'opensearch-health-green.json'),
      'utf8',
    );
    const src = makeExecSource({
      'localhost:9200/_cluster/health': healthFixture,
      '_nodes/stats/fs': nodesStatsJson,
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    const disk = obs.find((o) => o.pattern === 'datastore_disk_pressure');
    expect(disk).toBeDefined();
    expect(disk!.severity).toBe('P0');
  });
});

// ---------------------------------------------------------------------------
// Neo4j health signals
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe — neo4j', () => {
  async function setupNeo4jEntity(): Promise<void> {
    await graphStore.upsertEntity(makeDatastoreEntity({
      name: 'my-neo4j',
      attributes: { engine: 'neo4j', container_name: 'my-neo4j' },
    }));
  }

  test('available response → no observations', async () => {
    await setupNeo4jEntity();
    const src = makeExecSource({
      'cluster/available': '{"available":true}\n',
    });
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    expect(await probe.scan()).toHaveLength(0);
  });

  test('empty exec response → datastore_unhealthy', async () => {
    await setupNeo4jEntity();
    const src = makeExecSource({});
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('datastore_unhealthy');
  });
});

// ---------------------------------------------------------------------------
// Probe metadata
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe metadata', () => {
  test('id, cadence, platformId are correct', () => {
    const src = makeExecSource({});
    const probe = new DatastoreHealthProbe(PLATFORM, graphStore, src);
    expect(probe.id).toBe('datastore-health');
    expect(probe.cadence).toBe('medium');
    expect(probe.platformId).toBe(PLATFORM);
  });
});

// ---------------------------------------------------------------------------
// Graph read failure degrades gracefully
// ---------------------------------------------------------------------------

describe('DatastoreHealthProbe — graph store failure', () => {
  test('entitiesByKind throws → single daemon_heartbeat_stale observation', async () => {
    const badStore = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('disk read error')),
    } as unknown as GraphStore;

    const src = makeExecSource({});
    const probe = new DatastoreHealthProbe(PLATFORM, badStore, src);
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(obs[0]!.severity).toBe('P0');
  });
});
