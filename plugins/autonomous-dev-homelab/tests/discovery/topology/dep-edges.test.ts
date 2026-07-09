/**
 * Unit tests for the dependency-edge derivation (issue #29).
 *
 * Tests:
 * - collectAttributeStrings: flat strings, arrays, objects, env vars
 * - entityIdentifiers: name, host, ports
 * - candidateMatches: numeric ports, hostnames, short candidates
 * - DependencyEdgeDeriver.derive: service→service and service→datastore edges
 * - No self-reference edges emitted
 * - Deduplication: same pair emitted at most once
 * - Empty graph → empty result
 * - All derived edges have type='depends-on' and attributes.derived=true
 */

import {
  DependencyEdgeDeriver,
  collectAttributeStrings,
  entityIdentifiers,
  candidateMatches,
} from '../../../src/discovery/topology/dep-edges';
import type { Entity } from '../../../src/discovery/graph-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-01-15T00:00:00.000Z';

function makeEntity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    kind: 'service',
    attributes: {},
    source: 'test',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
    ...overrides,
  };
}

function makeGraphStore(opts: {
  services?: Entity[];
  containers?: Entity[];
  datastores?: Entity[];
}): import('../../../src/discovery/graph-store').GraphStore {
  const services = opts.services ?? [];
  const containers = opts.containers ?? [];
  const datastores = opts.datastores ?? [];
  return {
    entitiesByKind: jest.fn().mockImplementation((kind: string) => {
      if (kind === 'service') return Promise.resolve(services);
      if (kind === 'container') return Promise.resolve(containers);
      if (kind === 'datastore') return Promise.resolve(datastores);
      return Promise.resolve([]);
    }),
  } as unknown as import('../../../src/discovery/graph-store').GraphStore;
}

function makeDeriver(
  graphStore: ReturnType<typeof makeGraphStore>,
): DependencyEdgeDeriver {
  return new DependencyEdgeDeriver(graphStore as never, { clock: () => NOW });
}

// ---------------------------------------------------------------------------
// collectAttributeStrings
// ---------------------------------------------------------------------------

describe('collectAttributeStrings', () => {
  it('collects plain string attributes', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: { host: 'postgres-svc', version: '14' },
    });
    const result = collectAttributeStrings(e);
    expect(result).toContain('postgres-svc');
    expect(result).toContain('14');
  });

  it('collects strings from string arrays', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: { ports: ['*:5432->5432/tcp', '*:8080->8080/tcp'] },
    });
    const result = collectAttributeStrings(e);
    expect(result).toContain('*:5432->5432/tcp');
    expect(result).toContain('*:8080->8080/tcp');
  });

  it('collects leaf values from label objects', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: { labels: { 'com.example.db': 'postgres', version: '14' } },
    });
    const result = collectAttributeStrings(e);
    expect(result).toContain('postgres');
    expect(result).toContain('14');
  });

  it('collects KEY=value strings from env arrays', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: {
        env: ['DB_HOST=postgres-svc', 'DB_PORT=5432', 'DB_NAME=mydb'],
      },
    });
    const result = collectAttributeStrings(e);
    expect(result).toContain('DB_HOST=postgres-svc');
    expect(result).toContain('DB_PORT=5432');
  });

  it('converts numbers to strings', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: { port: 5432 },
    });
    const result = collectAttributeStrings(e);
    expect(result).toContain('5432');
  });
});

// ---------------------------------------------------------------------------
// entityIdentifiers
// ---------------------------------------------------------------------------

describe('entityIdentifiers', () => {
  it('includes entity name (lowercased)', () => {
    const e = makeEntity({ id: 'e1', name: 'PostgreSQL', attributes: {} });
    expect(entityIdentifiers(e).has('postgresql')).toBe(true);
  });

  it('includes host attribute (lowercased)', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'db',
      attributes: { host: 'Postgres-SVC' },
    });
    expect(entityIdentifiers(e).has('postgres-svc')).toBe(true);
  });

  it('includes port numbers from ports array', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'db',
      attributes: { ports: ['*:5432->5432/tcp'] },
    });
    const idents = entityIdentifiers(e);
    expect(idents.has('5432')).toBe(true);
  });

  it('handles empty ports array', () => {
    const e = makeEntity({
      id: 'e1',
      name: 'svc',
      attributes: { ports: [] },
    });
    // Should not throw and should return at least the name.
    const idents = entityIdentifiers(e);
    expect(idents.size).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// candidateMatches
// ---------------------------------------------------------------------------

describe('candidateMatches', () => {
  it('matches hostname substring in env var value', () => {
    expect(candidateMatches('DB_HOST=postgres-svc', 'postgres-svc')).toBe(true);
  });

  it('matches port number with boundary context', () => {
    expect(candidateMatches('DB_PORT=5432', '5432')).toBe(true);
    expect(candidateMatches('*:5432->5432/tcp', '5432')).toBe(true);
  });

  it('does not match port as arbitrary substring of a longer number', () => {
    // '5432' should not match inside '15432' or '54321' (word-boundary rule).
    expect(candidateMatches('value=15432', '5432')).toBe(false);
    expect(candidateMatches('value=54321', '5432')).toBe(false);
  });

  it('rejects candidates shorter than 4 chars to avoid false positives', () => {
    expect(candidateMatches('DB_PORT=80', '80')).toBe(false);
    expect(candidateMatches('DB_PORT=53', '53')).toBe(false);
  });

  it('is case-insensitive for hostname candidates', () => {
    expect(candidateMatches('REDIS_HOST=Redis-SVC', 'redis-svc')).toBe(true);
  });

  it('returns false when candidate does not appear', () => {
    expect(candidateMatches('completely unrelated string', 'postgres-svc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DependencyEdgeDeriver.derive — basic scenarios
// ---------------------------------------------------------------------------

describe('DependencyEdgeDeriver: basic dependency derivation', () => {
  it('returns empty result when graph is empty', async () => {
    const graphStore = makeGraphStore({});
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    expect(result.edges).toHaveLength(0);
    expect(result.sourcesInspected).toBe(0);
    expect(result.edgesDerived).toBe(0);
  });

  it('does not emit self-reference edges', async () => {
    const svc = makeEntity({
      id: 'svc:myapp',
      name: 'myapp',
      attributes: { env: ['APP_NAME=myapp', 'DB_HOST=postgres'] },
    });
    const db = makeEntity({
      id: 'svc:postgres',
      name: 'postgres',
      attributes: { ports: ['*:5432->5432/tcp'] },
    });
    const graphStore = makeGraphStore({ services: [svc, db] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    // Should not have a self-edge for myapp→myapp.
    const selfEdges = result.edges.filter(
      (e) => e.from === e.to,
    );
    expect(selfEdges).toHaveLength(0);
  });

  it('emits depends-on edge when a service env var references another service name', async () => {
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      attributes: { env: ['DB_HOST=postgres-svc', 'REDIS_URL=redis://redis-svc:6379'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: { ports: ['*:5432->5432/tcp'] },
    });
    const graphStore = makeGraphStore({ services: [webApp, dbService] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    const edge = result.edges.find(
      (e) => e.from === webApp.id && e.to === dbService.id,
    );
    expect(edge).toBeDefined();
    expect(edge!.type).toBe('depends-on');
  });

  it('emits depends-on edge service → datastore when datastore name appears in env', async () => {
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      attributes: { env: ['DATABASE_URL=postgresql://pgdb:5432/mydb'] },
    });
    const datastore = makeEntity({
      id: 'ds:pgdb',
      name: 'pgdb',
      kind: 'datastore',
      attributes: { host: 'pgdb' },
    });
    const graphStore = makeGraphStore({
      services: [webApp],
      datastores: [datastore],
    });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    const edge = result.edges.find(
      (e) => e.from === webApp.id && e.to === datastore.id,
    );
    expect(edge).toBeDefined();
    expect(edge!.type).toBe('depends-on');
  });

  it('all derived edges have type=depends-on and attributes.derived=true', async () => {
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      attributes: { env: ['DB_HOST=postgres-svc'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: {},
    });
    const graphStore = makeGraphStore({ services: [webApp, dbService] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    for (const edge of result.edges) {
      expect(edge.type).toBe('depends-on');
      expect(edge.attributes?.['derived']).toBe(true);
    }
  });

  it('deduplicates: same pair produces only one edge', async () => {
    // Service has BOTH the name AND a port that match the target.
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      // References postgres-svc by name AND by port
      attributes: { env: ['DB_HOST=postgres-svc', 'DB_PORT=5432'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: { ports: ['*:5432->5432/tcp'] },
    });
    const graphStore = makeGraphStore({ services: [webApp, dbService] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    // Despite multiple matches, only one edge between the pair.
    const edges = result.edges.filter(
      (e) => e.from === webApp.id && e.to === dbService.id,
    );
    expect(edges).toHaveLength(1);
  });

  it('includes container entities as sources', async () => {
    const container = makeEntity({
      id: 'container:webapp:task1',
      name: 'webapp.1.xyz',
      kind: 'container',
      attributes: { env: ['DB_HOST=postgres-svc'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: {},
    });
    const graphStore = makeGraphStore({
      containers: [container],
      services: [dbService],
    });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    const edge = result.edges.find(
      (e) => e.from === container.id && e.to === dbService.id,
    );
    expect(edge).toBeDefined();
  });

  it('edge ids are deterministic: depends-on:<sourceId>:<targetId>', async () => {
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      attributes: { env: ['DB_HOST=postgres-svc'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: {},
    });
    const graphStore = makeGraphStore({ services: [webApp, dbService] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    const edge = result.edges.find(
      (e) => e.from === webApp.id && e.to === dbService.id,
    );
    expect(edge!.id).toBe(`depends-on:${webApp.id}:${dbService.id}`);
  });

  it('does not emit edge when no reference is found', async () => {
    const webApp = makeEntity({
      id: 'svc:webapp',
      name: 'webapp',
      attributes: { env: ['COMPLETELY_UNRELATED=foo'] },
    });
    const dbService = makeEntity({
      id: 'svc:postgres',
      name: 'postgres-svc',
      attributes: {},
    });
    const graphStore = makeGraphStore({ services: [webApp, dbService] });
    const deriver = makeDeriver(graphStore);
    const result = await deriver.derive();

    expect(result.edges).toHaveLength(0);
  });
});
