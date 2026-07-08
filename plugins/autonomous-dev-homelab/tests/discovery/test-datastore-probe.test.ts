/**
 * Tests for DatastoreProbe (issue #42) and the per-engine probe registry.
 *
 * Invariant #62 compliance:
 * - All entity names in fixtures are generic (e.g. "my-postgres", "my-redis")
 *   and chosen to test structural/classification logic, not specific homelab names.
 * - No hard-coded credentials in assertions.
 * - Engine probes match by generic image-name signals; tests verify structural
 *   assertions (kind, attributes.engine, children count) not instance-specific values.
 *
 * No live Docker or network access — all Connection.exec calls are mocked.
 */

import * as path from 'node:path';
import {
  DatastoreProbe,
  registerEngineProbe,
  findEngineProbe,
  registeredEngines,
  imageContains,
  type DatastoreEngineProbe,
  type DatastoreIntrospection,
} from '../../src/discovery/datastore-probe';
import { GraphStore } from '../../src/discovery/graph-store';
import type { Entity } from '../../src/discovery/graph-types';
import type { Connection, ExecResult } from '../../src/connection/base';
import { fileMutex } from '../../src/util/file-mutex';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-06-23T12:00:00.000Z';

function makeEntity(overrides: Partial<Entity> & { name: string }): Entity {
  return {
    id: `service:platform-1:${overrides.name}`,
    kind: 'service',
    attributes: {},
    source: 'docker-swarm',
    platformId: 'platform-1',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
    ...overrides,
  };
}

function makeMockConnection(responses: Record<string, string>): Connection {
  return {
    platformId: 'platform-1',
    exec: jest.fn().mockImplementation(async (cmd: string): Promise<ExecResult> => {
      for (const [key, value] of Object.entries(responses)) {
        if (cmd.includes(key)) {
          return { stdout: value, stderr: '', exitCode: 0, durationMs: 1 };
        }
      }
      return { stdout: '', stderr: 'not found', exitCode: 1, durationMs: 1 };
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    getCapabilities: jest.fn().mockReturnValue(undefined),
    getLastUsedAt: jest.fn().mockReturnValue(0),
  } as unknown as Connection;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let graphStorePath: string;
let graphStore: GraphStore;

beforeEach(async () => {
  tmpDir = await mkTempDir('test-datastore-probe');
  graphStorePath = path.join(tmpDir, 'inventory-graph.yaml');
  graphStore = new GraphStore(graphStorePath, { mutex: fileMutex() });
});

afterEach(async () => {
  await rmTempDir(tmpDir);
});

// ---------------------------------------------------------------------------
// imageContains helper
// ---------------------------------------------------------------------------

describe('imageContains', () => {
  test('returns true when image contains any of the given substrings (case-insensitive)', () => {
    const entity = makeEntity({
      name: 'my-db',
      attributes: { image: 'docker.io/library/Postgres:16' },
    });
    expect(imageContains(entity, 'postgres')).toBe(true);
    expect(imageContains(entity, 'POSTGRES')).toBe(true);
    expect(imageContains(entity, 'redis', 'postgres')).toBe(true);
  });

  test('returns false when image does not match', () => {
    const entity = makeEntity({
      name: 'my-app',
      attributes: { image: 'my-custom-app:1.0' },
    });
    expect(imageContains(entity, 'postgres', 'redis', 'opensearch')).toBe(false);
  });

  test('returns false when image attribute is absent', () => {
    const entity = makeEntity({ name: 'no-image' });
    expect(imageContains(entity, 'postgres')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine probe registry
// ---------------------------------------------------------------------------

describe('registeredEngines', () => {
  test('returns at least the 4 built-in engines', () => {
    const engines = registeredEngines();
    expect(engines).toContain('postgres');
    expect(engines).toContain('redis');
    expect(engines).toContain('opensearch');
    expect(engines).toContain('neo4j');
  });

  test('findEngineProbe returns undefined for an unrelated entity', () => {
    const entity = makeEntity({ name: 'nginx', attributes: { image: 'nginx:1.25' } });
    expect(findEngineProbe(entity)).toBeUndefined();
  });
});

describe('engine probe matching (invariant #62: generic image signals)', () => {
  const cases: Array<{ engine: string; image: string }> = [
    { engine: 'postgres', image: 'docker.io/library/postgres:16' },
    { engine: 'postgres', image: 'timescaledb/timescaledb:latest' },
    { engine: 'redis', image: 'redis:7-alpine' },
    { engine: 'redis', image: 'valkey/valkey:7.2' },
    { engine: 'opensearch', image: 'opensearchproject/opensearch:2.12' },
    { engine: 'opensearch', image: 'docker.elastic.co/elasticsearch/elasticsearch:8.12.0' },
    { engine: 'neo4j', image: 'neo4j:5.18-community' },
  ];

  test.each(cases)('$image → engine=$engine', ({ engine, image }) => {
    const entity = makeEntity({ name: 'test-db', attributes: { image } });
    const probe = findEngineProbe(entity);
    expect(probe).toBeDefined();
    expect(probe!.engine).toBe(engine);
  });

  test('registerEngineProbe allows new engines to plug in without core edits', () => {
    const customProbe: DatastoreEngineProbe = {
      engine: 'mycustomdb',
      matches: (e) => imageContains(e, 'mycustomdb'),
      introspect: async () => ({
        engine: 'mycustomdb',
        version: '1.0',
        health: 'ok' as const,
        children: [],
      }),
    };
    registerEngineProbe(customProbe);
    const entity = makeEntity({ name: 'custom', attributes: { image: 'mycustomdb:latest' } });
    expect(findEngineProbe(entity)).toBe(customProbe);
    // Cleanup: overwrite with undefined-like; registry is open — just verify the API works.
  });
});

// ---------------------------------------------------------------------------
// DatastoreProbe.probe() — discovery path
// ---------------------------------------------------------------------------

describe('DatastoreProbe.probe()', () => {
  test('returns discovered=0 when graph has no candidate entities', async () => {
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe();
    expect(result.discovered).toBe(0);
    expect(result.introspected).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  test('finds entities by role=database without a connection (graceful no-introspect)', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-postgres',
      attributes: { image: 'postgres:16', role: 'database' },
    }));
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    // No connection passed → health=unknown, children=[]
    const result = await probe.probe();
    expect(result.discovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.introspected).toBe(0);
    expect(result.results[0]!.datastoreEntity.kind).toBe('datastore');
    expect(result.results[0]!.datastoreEntity.attributes['engine']).toBe('postgres');
    expect(result.results[0]!.datastoreEntity.attributes['health']).toBe('unknown');
    expect(result.results[0]!.children).toHaveLength(0);
  });

  test('finds entities by role=cache without a connection', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-redis',
      attributes: { image: 'redis:7', role: 'cache' },
    }));
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe();
    expect(result.discovered).toBe(1);
    expect(result.results[0]!.datastoreEntity.attributes['engine']).toBe('redis');
  });

  test('finds entities by image signal even without a role tag', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'raw-pg',
      attributes: { image: 'bitnami/postgresql:16.1' },
    }));
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe();
    expect(result.discovered).toBe(1);
    expect(result.results[0]!.datastoreEntity.attributes['engine']).toBe('postgres');
  });

  test('upserts datastore entity into graph store', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-redis',
      attributes: { image: 'redis:7', role: 'cache' },
    }));
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    await probe.probe();
    const datastores = await graphStore.entitiesByKind('datastore');
    expect(datastores).toHaveLength(1);
    expect(datastores[0]!.name).toBe('my-redis');
  });

  test('skips non-datastore entities (neither role nor image match)', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-nginx',
      attributes: { image: 'nginx:1.25', role: 'reverse-proxy' },
    }));
    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe();
    expect(result.discovered).toBe(0);
  });

  test('with live connection: postgres engine introspects databases and upserts children + edges', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-postgres',
      attributes: { image: 'postgres:16', role: 'database', container_name: 'my-postgres' },
    }));

    const conn = makeMockConnection({
      'SELECT version()': 'PostgreSQL 16.1 on x86_64\n',
      'pg_database_size': 'appdb|52428800\nlogs|10485760\n',
      'pg_is_in_recovery': 'f\n',
      'pg_last_xact_replay_timestamp': '',
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);

    expect(result.introspected).toBe(1);
    expect(result.skipped).toBe(0);

    const ds = result.results[0]!;
    expect(ds.datastoreEntity.kind).toBe('datastore');
    expect(ds.datastoreEntity.attributes['engine']).toBe('postgres');
    expect(ds.datastoreEntity.attributes['health']).toBe('ok');
    expect(ds.datastoreEntity.attributes['replication_role']).toBe('primary');

    // children should include two databases (structure-only, no values read)
    expect(ds.children).toHaveLength(2);
    expect(ds.children.map((c) => c.name).sort()).toEqual(['appdb', 'logs']);
    expect(ds.children[0]!.kind).toBe('database');
    expect(ds.children[0]!.attributes['size_bytes']).toBeGreaterThan(0);

    // edges: member-of from each child to the datastore
    expect(ds.edges).toHaveLength(2);
    expect(ds.edges[0]!.type).toBe('member-of');
    expect(ds.edges[0]!.to).toBe(ds.datastoreEntity.id);
  });

  test('with live connection: redis engine introspects keyspaces', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-redis',
      attributes: { image: 'redis:7', role: 'cache', container_name: 'my-redis' },
    }));

    const conn = makeMockConnection({
      'redis-cli PING': 'PONG\n',
      'redis-cli INFO server': 'redis_version:7.2.4\n',
      'redis-cli INFO keyspace': 'db0:keys=1500,expires=200,avg_ttl=3600000\ndb1:keys=250,expires=0,avg_ttl=0\n',
      'redis-cli INFO replication': 'role:master\n',
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);

    expect(result.introspected).toBe(1);
    const ds = result.results[0]!;
    expect(ds.datastoreEntity.attributes['engine']).toBe('redis');
    expect(ds.datastoreEntity.attributes['health']).toBe('ok');
    expect(ds.children).toHaveLength(2);
    expect(ds.children.map((c) => c.name).sort()).toEqual(['db0', 'db1']);
    // structure-only: counts are integers, no key values
    expect(ds.children[0]!.attributes['count']).toBeGreaterThan(0);
    // size_bytes is -1 for Redis (byte size not directly available)
    expect(ds.children[0]!.attributes['size_bytes']).toBe(-1);
  });

  test('with live connection: opensearch engine introspects indices', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-opensearch',
      attributes: { image: 'opensearchproject/opensearch:2.12', role: 'observability', container_name: 'my-opensearch' },
    }));

    // Note: key ordering matters — more specific paths listed first to avoid
    // prefix collision when using includes() for matching.
    const conn = makeMockConnection({
      '_cluster/health': JSON.stringify({
        status: 'green',
        unassigned_shards: 0,
      }) + '\n',
      '_cat/indices': JSON.stringify([
        { index: 'logs-2026', 'store.size': '1.2gb', 'docs.count': '5000000' },
        { index: '.security-7', 'store.size': '100kb', 'docs.count': '10' },
      ]) + '\n',
      '_nodes/stats/fs': '{}',
      'localhost:9200/': JSON.stringify({
        name: 'node-1',
        version: { number: '2.12.0', distribution: 'opensearch' },
      }) + '\n',
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);

    expect(result.introspected).toBe(1);
    const ds = result.results[0]!;
    expect(ds.datastoreEntity.attributes['engine']).toBe('opensearch');
    expect(ds.datastoreEntity.attributes['version']).toBe('2.12.0');
    expect(ds.datastoreEntity.attributes['health']).toBe('ok');
    // system index (.security-7) should be filtered out
    expect(ds.children).toHaveLength(1);
    expect(ds.children[0]!.name).toBe('logs-2026');
  });

  test('with live connection: neo4j engine introspects databases', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-neo4j',
      attributes: { image: 'neo4j:5.18-community', role: 'database', container_name: 'my-neo4j' },
    }));

    const conn = makeMockConnection({
      'cypher-shell': 'name,currentStatus\n"neo4j","online"\n"myapp","online"\n',
      'curl -s http://localhost:7474/': JSON.stringify({ neo4j_version: '5.18.0' }) + '\n',
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);

    expect(result.introspected).toBe(1);
    const ds = result.results[0]!;
    expect(ds.datastoreEntity.attributes['engine']).toBe('neo4j');
    expect(ds.datastoreEntity.attributes['version']).toBe('5.18.0');
    expect(ds.datastoreEntity.attributes['health']).toBe('ok');
    // "system" is filtered; "neo4j" and "myapp" should be included
    expect(ds.children.map((c) => c.name)).toContain('myapp');
  });

  test('postgres: exec failure → health=unknown, children=[] (graceful degradation)', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-postgres',
      attributes: { image: 'postgres:16', role: 'database', container_name: 'my-postgres' },
    }));

    const conn: Connection = {
      platformId: 'platform-1',
      exec: jest.fn().mockRejectedValue(new Error('connection refused')),
      connect: jest.fn(),
      disconnect: jest.fn(),
      isConnected: jest.fn().mockReturnValue(false),
      getCapabilities: jest.fn(),
      getLastUsedAt: jest.fn().mockReturnValue(0),
    } as unknown as Connection;

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);
    expect(result.skipped).toBe(1);
    expect(result.introspected).toBe(0);
    const ds = result.results[0]!;
    expect(ds.datastoreEntity.attributes['health']).toBe('unknown');
    expect(ds.children).toHaveLength(0);
    // INVARIANT: No user data exposed in the entity attributes
    expect(Object.keys(ds.datastoreEntity.attributes)).not.toContain('row_values');
    expect(Object.keys(ds.datastoreEntity.attributes)).not.toContain('key_values');
  });

  test('redis: PING fails → health=down (probe ran, not skipped)', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-redis',
      attributes: { image: 'redis:7', role: 'cache', container_name: 'my-redis' },
    }));

    const conn = makeMockConnection({
      'redis-cli PING': '', // non-PONG response
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);
    // health='down' means the probe ran and got a definitive result (not 'unknown')
    expect(result.introspected).toBe(1);
    expect(result.skipped).toBe(0);
    const ds = result.results[0]!;
    expect(ds.datastoreEntity.attributes['health']).toBe('down');
  });

  test('multiple datastores: each processed independently', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'pg-primary',
      attributes: { image: 'postgres:16', role: 'database', container_name: 'pg-primary' },
    }));
    await graphStore.upsertEntity(makeEntity({
      id: 'service:platform-1:redis-cache',
      name: 'redis-cache',
      attributes: { image: 'redis:7', role: 'cache', container_name: 'redis-cache' },
    }));

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    // No connection → both skipped gracefully
    const result = await probe.probe();
    expect(result.discovered).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.results).toHaveLength(2);
    const engines = result.results.map((r) => r.datastoreEntity.attributes['engine']).sort();
    expect(engines).toEqual(['postgres', 'redis']);
  });

  test('child entity ids are deterministic composites', async () => {
    await graphStore.upsertEntity(makeEntity({
      name: 'my-postgres',
      attributes: { image: 'postgres:16', role: 'database', container_name: 'my-postgres' },
    }));

    const conn = makeMockConnection({
      'SELECT version()': 'PostgreSQL 16.1\n',
      'pg_database_size': 'mydb|1024\n',
      'pg_is_in_recovery': 'f\n',
    });

    const probe = new DatastoreProbe(graphStore, { now: NOW });
    const result = await probe.probe(conn);
    const child = result.results[0]!.children[0]!;
    // ID must be deterministic: database:<datastoreEntityId>:<childName>
    expect(child.id).toMatch(/^database:datastore:platform-1:my-postgres:mydb$/);
  });
});
