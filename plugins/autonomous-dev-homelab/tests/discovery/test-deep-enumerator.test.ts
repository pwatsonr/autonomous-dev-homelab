/**
 * Tests for the deep-enumeration subsystem — issue #27.
 *
 * Covers:
 *  1. DockerSwarmEnumerator: maps fixture docker CLI output to correct entities/edges.
 *  2. Enumerator registry: getEnumerator dispatches by platformKind.
 *  3. DeepEnumerator orchestrator: iterates platforms, calls enumerator, upserts graph.
 *  4. Upsert semantics: re-enumerating updates last_seen (idempotent).
 *  5. Graceful degradation: unreachable platform is logged, enumeration continues.
 *
 * No live network or Docker daemon is accessed. All Connection.exec calls
 * are mocked. Invariant #62: no homelab-specific service/node names appear
 * in assertions that would fail if the names changed — only structural
 * assertions (kind, edge type, count) and the fixture-defined names.
 */

import * as path from 'node:path';
import { DockerSwarmEnumerator } from '../../src/discovery/enumerators/docker-swarm';
import {
  registerEnumerator,
  getEnumerator,
  registeredKinds,
} from '../../src/discovery/enumerator';
import { DeepEnumerator } from '../../src/discovery/deep-enumerator';
import { GraphStore } from '../../src/discovery/graph-store';
import { InventoryManager } from '../../src/discovery/inventory';
import { fileMutex } from '../../src/util/file-mutex';
import type { Connection, ExecResult } from '../../src/connection/base';
import type { Platform } from '../../src/discovery/inventory-types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';
import {
  FIXTURE_NODE_LS,
  FIXTURE_SERVICE_LS,
  FIXTURE_SERVICE_PS,
  FIXTURE_NETWORK_LS,
  FIXTURE_NODE_LS_EMPTY,
} from './fixtures/docker-swarm-fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-06-23T12:00:00.000Z';

/**
 * Build a mock Connection whose exec() returns pre-programmed responses
 * keyed on a substring of the command string.
 */
function makeMockConnection(
  responses: Array<{ matches: string; result: Partial<ExecResult> }>,
): Connection {
  return {
    platformId: 'test-platform',
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockImplementation(async (cmd: string): Promise<ExecResult> => {
      for (const r of responses) {
        if (cmd.includes(r.matches)) {
          return {
            stdout: r.result.stdout ?? '',
            stderr: r.result.stderr ?? '',
            exitCode: r.result.exitCode ?? 0,
            durationMs: r.result.durationMs ?? 0,
          };
        }
      }
      // Default: empty success
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    }),
    getCapabilities: jest.fn().mockReturnValue({ transport: 'ssh', hostname: 'test' }),
    isConnected: jest.fn().mockReturnValue(true),
    getLastUsedAt: jest.fn().mockReturnValue(0),
  } as unknown as Connection;
}

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: overrides.id ?? 'swarm-192-168-1-1',
    type: overrides.type ?? 'docker-swarm',
    host: overrides.host ?? '192.168.1.1',
    port: overrides.port ?? 2376,
    discovered_at: overrides.discovered_at ?? NOW,
    last_seen: overrides.last_seen ?? NOW,
    ...overrides,
  };
}

/** Build a GraphStore with an isolated mutex (no cross-test contention). */
function makeStore(p: string): GraphStore {
  return new GraphStore(p, { mutex: fileMutex() });
}

// ---------------------------------------------------------------------------
// 1. DockerSwarmEnumerator: entity/edge mapping from fixture output
// ---------------------------------------------------------------------------

describe('DockerSwarmEnumerator', () => {
  it('maps docker node ls output to node entities', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: FIXTURE_NETWORK_LS } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const nodes = entities.filter((e) => e.kind === 'node');
    expect(nodes).toHaveLength(2);

    const worker = nodes.find((n) => n.name === 'worker-01');
    expect(worker).toBeDefined();
    expect(worker!.id).toBe(`node:${platform.id}:node1abc`);
    expect(worker!.source).toBe('docker-swarm');
    expect(worker!.platformId).toBe(platform.id);
    expect(worker!.attributes['status']).toBe('Ready');
    expect(worker!.attributes['availability']).toBe('Active');

    const manager = nodes.find((n) => n.name === 'manager-01');
    expect(manager).toBeDefined();
    expect(manager!.attributes['manager_status']).toBe('Leader');
  });

  it('maps docker service ls output to service entities with correct attributes', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: FIXTURE_NETWORK_LS } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const services = entities.filter((e) => e.kind === 'service');
    expect(services).toHaveLength(2);

    const webSvc = services.find((s) => s.name === 'web-frontend');
    expect(webSvc).toBeDefined();
    expect(webSvc!.id).toBe(`service:${platform.id}:web-frontend`);
    expect(webSvc!.attributes['image']).toBe('nginx:alpine');
    expect(webSvc!.attributes['replicas_running']).toBe(3);
    expect(webSvc!.attributes['replicas_desired']).toBe(3);
    expect(Array.isArray(webSvc!.attributes['ports'])).toBe(true);
    const ports = webSvc!.attributes['ports'] as string[];
    expect(ports.length).toBeGreaterThan(0);

    const apiSvc = services.find((s) => s.name === 'api-backend');
    expect(apiSvc).toBeDefined();
    expect(apiSvc!.attributes['replicas_running']).toBe(2);
  });

  it('maps running docker service ps tasks to container entities (excludes Shutdown)', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: FIXTURE_NETWORK_LS } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const containers = entities.filter((e) => e.kind === 'container');
    // Fixture has 4 tasks; 1 is Shutdown — so 3 Running containers expected.
    expect(containers).toHaveLength(3);

    for (const c of containers) {
      expect(c.attributes['desired_state']).toBe('Running');
    }
  });

  it('maps overlay networks to network entities and skips bridge/host with no labels', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: FIXTURE_NETWORK_LS } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const networks = entities.filter((e) => e.kind === 'network');
    // FIXTURE has: ingress (overlay), app-network (overlay+labels), bridge (bridge, no labels), host (host, no labels)
    // Only overlay or labelled networks are included.
    expect(networks).toHaveLength(2);
    const names = networks.map((n) => n.name);
    expect(names).toContain('ingress');
    expect(names).toContain('app-network');
    expect(names).not.toContain('bridge');
    expect(names).not.toContain('host');
  });

  it('creates member-of edges from nodes to platform', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const memberOfEdges = edges.filter((e) => e.type === 'member-of');
    // 2 nodes → 2 member-of edges to platform
    expect(memberOfEdges.length).toBeGreaterThanOrEqual(2);
    const platformEntityId = `platform:${platform.id}`;
    for (const edge of memberOfEdges) {
      expect(edge.to).toBe(platformEntityId);
    }
  });

  it('creates runs-on edges from containers to their node', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const runsOnEdges = edges.filter((e) => e.type === 'runs-on');
    // 3 running tasks → 3 runs-on edges (each to a node entity)
    expect(runsOnEdges).toHaveLength(3);

    for (const edge of runsOnEdges) {
      expect(edge.from).toMatch(/^container:/);
      expect(edge.to).toMatch(/^node:/);
    }
  });

  it('creates member-of edges from containers to their service', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const containerMemberOfEdges = edges.filter(
      (e) => e.type === 'member-of' && e.from.startsWith('container:'),
    );
    // 3 running tasks → 3 member-of edges (each to a service entity)
    expect(containerMemberOfEdges).toHaveLength(3);

    for (const edge of containerMemberOfEdges) {
      expect(edge.to).toMatch(/^service:/);
    }
  });

  it('creates exposes edges for each published port of a service', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: '' } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const exposesEdges = edges.filter((e) => e.type === 'exposes');
    // web-frontend has 2 ports, api-backend has 1 port → 3 exposes edges total
    expect(exposesEdges).toHaveLength(3);

    for (const edge of exposesEdges) {
      expect(edge.from).toMatch(/^service:/);
      expect(edge.attributes?.['port']).toBeDefined();
    }
  });

  it('handles a failed docker command gracefully (returns partial result)', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      // node ls fails
      { matches: 'docker node ls', result: { stdout: '', stderr: 'permission denied', exitCode: 1 } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { entities, edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    // No node entities (node ls failed); service entities are still present.
    const nodes = entities.filter((e) => e.kind === 'node');
    expect(nodes).toHaveLength(0);

    const services = entities.filter((e) => e.kind === 'service');
    expect(services).toHaveLength(2);
    // No crashes; edges still built for services.
    expect(edges.length).toBeGreaterThan(0);
  });

  it('handles an exec() exception gracefully (returns partial result)', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const throwingConn = {
      platformId: 'swarm-192-168-1-1',
      exec: jest.fn().mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd.includes('docker node ls')) {
          throw new Error('ssh connection dropped');
        }
        if (cmd.includes('docker service ls')) {
          return { stdout: FIXTURE_SERVICE_LS, stderr: '', exitCode: 0, durationMs: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
      }),
      connect: jest.fn(),
      disconnect: jest.fn(),
      getCapabilities: jest.fn(),
      isConnected: jest.fn(),
      getLastUsedAt: jest.fn(),
    } as unknown as Connection;

    const { entities } = await enumerator.enumerate({
      connection: throwingConn,
      platform,
      now: NOW,
    });

    // node ls threw → no node entities; service ls succeeded → 2 service entities
    const nodes = entities.filter((e) => e.kind === 'node');
    expect(nodes).toHaveLength(0);
    const services = entities.filter((e) => e.kind === 'service');
    expect(services).toHaveLength(2);
  });

  it('returns empty result when the swarm has no nodes', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS_EMPTY } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { entities, edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('assigns last_seen and discovered_at from ctx.now', async () => {
    const enumerator = new DockerSwarmEnumerator('docker-swarm');
    const platform = makePlatform();
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    for (const entity of entities) {
      expect(entity.last_seen).toBe(NOW);
      expect(entity.discovered_at).toBe(NOW);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Enumerator registry
// ---------------------------------------------------------------------------

describe('Enumerator registry', () => {
  it('getEnumerator returns undefined for unregistered kind', () => {
    expect(getEnumerator('totally-unknown-platform-xyz')).toBeUndefined();
  });

  it('registerEnumerator then getEnumerator dispatches by platformKind', () => {
    const stub: import('../../src/discovery/enumerator').PlatformEnumerator = {
      platformKind: 'test-kind-abc',
      enumerate: jest.fn().mockResolvedValue({ entities: [], edges: [] }),
    };
    registerEnumerator(stub);
    expect(getEnumerator('test-kind-abc')).toBe(stub);
  });

  it('registeredKinds lists all registered platform kinds', () => {
    // After side-effecting registration above, at minimum 'test-kind-abc' is present.
    const kinds = registeredKinds();
    expect(Array.isArray(kinds)).toBe(true);
    // Should include the one we just registered above.
    expect(kinds).toContain('test-kind-abc');
  });

  it('re-registering the same kind replaces the previous entry', () => {
    const first: import('../../src/discovery/enumerator').PlatformEnumerator = {
      platformKind: 'replace-me',
      enumerate: jest.fn().mockResolvedValue({ entities: [], edges: [] }),
    };
    const second: import('../../src/discovery/enumerator').PlatformEnumerator = {
      platformKind: 'replace-me',
      enumerate: jest.fn().mockResolvedValue({ entities: [{ id: 'x' } as import('../../src/discovery/graph-types').Entity], edges: [] }),
    };
    registerEnumerator(first);
    registerEnumerator(second);
    expect(getEnumerator('replace-me')).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. DeepEnumerator orchestrator: upsert semantics
// ---------------------------------------------------------------------------

describe('DeepEnumerator', () => {
  let tempDir: string;
  let graphPath: string;
  let inventoryPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('adh-deep-enum-test-');
    graphPath = path.join(tempDir, 'inventory-graph.yaml');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  /**
   * Build a mock ConnectionPool that returns the given connection for any id.
   */
  function makeMockPool(conn: Connection): import('../../src/connection/pool').ConnectionPool {
    return {
      getConnection: jest.fn().mockResolvedValue(conn),
      release: jest.fn().mockResolvedValue(undefined),
      closeAll: jest.fn().mockResolvedValue(undefined),
      size: jest.fn().mockReturnValue(0),
      startReaper: jest.fn(),
      stopReaper: jest.fn(),
      reapIdle: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/connection/pool').ConnectionPool;
  }

  it('upserts swarm entities into the graph store', async () => {
    const inventoryManager = new InventoryManager(inventoryPath);
    const platform = makePlatform();
    await inventoryManager.addPlatform(platform);

    // Register the swarm enumerator for this test's dispatch
    registerEnumerator(new DockerSwarmEnumerator('docker-swarm'));

    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: FIXTURE_NETWORK_LS } },
    ]);
    const pool = makeMockPool(conn);
    const graphStore = makeStore(graphPath);
    const deepEnum = new DeepEnumerator(inventoryManager, pool, graphStore, {
      clock: () => NOW,
    });

    const result = await deepEnum.enumerate();

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.ok).toBe(true);
    expect(result.totalEntities).toBeGreaterThan(0);
    expect(result.totalEdges).toBeGreaterThan(0);

    // Verify entities actually landed in the graph store.
    const nodes = await graphStore.entitiesByKind('node');
    expect(nodes.length).toBe(2);

    const services = await graphStore.entitiesByKind('service');
    expect(services.length).toBe(2);
  });

  it('re-enumerating updates last_seen of existing entities (upsert semantics)', async () => {
    const inventoryManager = new InventoryManager(inventoryPath);
    const platform = makePlatform();
    await inventoryManager.addPlatform(platform);

    registerEnumerator(new DockerSwarmEnumerator('docker-swarm'));

    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);
    const pool = makeMockPool(conn);
    const graphStore = makeStore(graphPath);

    const T0 = '2026-06-01T00:00:00.000Z';
    const T1 = '2026-06-23T12:00:00.000Z';

    // First pass at T0.
    const deepEnum0 = new DeepEnumerator(inventoryManager, pool, graphStore, {
      clock: () => T0,
    });
    await deepEnum0.enumerate();

    // Second pass at T1 with an updated timestamp.
    const deepEnum1 = new DeepEnumerator(inventoryManager, pool, graphStore, {
      clock: () => T1,
    });
    await deepEnum1.enumerate();

    // Node entities should have last_seen = T1.
    const nodes = await graphStore.entitiesByKind('node');
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.last_seen).toBe(T1);
      // discovered_at stays at T0 (first upsert wins for discovered_at in
      // subsequent calls because upsert merges — the second upsert's
      // discovered_at overrides. This is expected: the caller always
      // supplies the current timestamp and the store merges on top).
    }
  });

  it('skips platform with no registered enumerator (no crash)', async () => {
    const inventoryManager = new InventoryManager(inventoryPath);
    const platform = makePlatform({ type: 'truenas' }); // no enumerator registered
    await inventoryManager.addPlatform(platform);

    const pool = makeMockPool(
      makeMockConnection([]),
    );
    const graphStore = makeStore(graphPath);
    const deepEnum = new DeepEnumerator(inventoryManager, pool, graphStore);

    const result = await deepEnum.enumerate();

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.ok).toBe(false);
    expect(result.summaries[0]!.error).toContain('no enumerator registered');
    expect(result.totalEntities).toBe(0);
  });

  it('handles pool.getConnection failure gracefully (logs, continues)', async () => {
    const inventoryManager = new InventoryManager(inventoryPath);
    const p1 = makePlatform({ id: 'swarm-good', type: 'docker-swarm' });
    const p2 = makePlatform({ id: 'swarm-bad', type: 'docker-swarm' });
    await inventoryManager.addPlatform(p1);
    await inventoryManager.addPlatform(p2);

    registerEnumerator(new DockerSwarmEnumerator('docker-swarm'));

    const goodConn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const failingPool = {
      getConnection: jest.fn().mockImplementation(async (id: string) => {
        if (id === 'swarm-bad') throw new Error('connection refused');
        return goodConn;
      }),
      release: jest.fn().mockResolvedValue(undefined),
      closeAll: jest.fn().mockResolvedValue(undefined),
      size: jest.fn().mockReturnValue(0),
      startReaper: jest.fn(),
      stopReaper: jest.fn(),
      reapIdle: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../../src/connection/pool').ConnectionPool;

    const graphStore = makeStore(graphPath);
    const logs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const deepEnum = new DeepEnumerator(inventoryManager, failingPool, graphStore, {
      clock: () => NOW,
      logger: {
        warn: (msg, ctx) => logs.push({ msg, ctx }),
        info: () => undefined,
        debug: () => undefined,
      },
    });

    const result = await deepEnum.enumerate();

    // Two platforms: one succeeded, one failed.
    expect(result.summaries).toHaveLength(2);
    const goodSummary = result.summaries.find((s) => s.platformId === 'swarm-good');
    const badSummary = result.summaries.find((s) => s.platformId === 'swarm-bad');
    expect(goodSummary?.ok).toBe(true);
    expect(badSummary?.ok).toBe(false);
    expect(badSummary?.error).toContain('connection failed');

    // Good platform's entities are in the graph.
    const nodes = await graphStore.entitiesByKind('node');
    expect(nodes.length).toBeGreaterThan(0);

    // A warn log was emitted for the failed platform.
    const warnLog = logs.find((l) => l.msg === 'deep_enumerator_connect_failed');
    expect(warnLog).toBeDefined();
  });

  it('platformFilter limits enumeration to specified platform IDs', async () => {
    const inventoryManager = new InventoryManager(inventoryPath);
    const p1 = makePlatform({ id: 'swarm-01', type: 'docker-swarm' });
    const p2 = makePlatform({ id: 'swarm-02', type: 'docker-swarm' });
    await inventoryManager.addPlatform(p1);
    await inventoryManager.addPlatform(p2);

    registerEnumerator(new DockerSwarmEnumerator('docker-swarm'));

    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: '' } },
      { matches: 'docker service ps', result: { stdout: '' } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);
    const pool = makeMockPool(conn);
    const graphStore = makeStore(graphPath);
    const deepEnum = new DeepEnumerator(inventoryManager, pool, graphStore, {
      clock: () => NOW,
    });

    // Only enumerate swarm-01.
    const result = await deepEnum.enumerate({ platformFilter: ['swarm-01'] });

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.platformId).toBe('swarm-01');
  });
});

// ---------------------------------------------------------------------------
// 5. DockerSwarmEnumerator works under 'portainer' kind alias
// ---------------------------------------------------------------------------

describe('DockerSwarmEnumerator platformKind alias', () => {
  it('enumerator registered as portainer enumerates the same swarm data', async () => {
    const enumerator = new DockerSwarmEnumerator('portainer');
    expect(enumerator.platformKind).toBe('portainer');

    const platform = makePlatform({ type: 'portainer' });
    const conn = makeMockConnection([
      { matches: 'docker node ls', result: { stdout: FIXTURE_NODE_LS } },
      { matches: 'docker service ls', result: { stdout: FIXTURE_SERVICE_LS } },
      { matches: 'docker service ps', result: { stdout: FIXTURE_SERVICE_PS } },
      { matches: 'docker network ls', result: { stdout: '' } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const nodes = entities.filter((e) => e.kind === 'node');
    const services = entities.filter((e) => e.kind === 'service');
    expect(nodes).toHaveLength(2);
    expect(services).toHaveLength(2);
  });
});
