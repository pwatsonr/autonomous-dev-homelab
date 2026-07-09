/**
 * Unit tests for the NPM reverse-proxy route adapter (issue #29).
 *
 * Tests:
 * - Sample proxy-host JSON → route entities + edges
 * - Route → target service matching (strategies 1-3)
 * - Graceful degradation: no reverse-proxy entity in graph
 * - Graceful degradation: no NPM_API_TOKEN
 * - Graceful degradation: NPM API unreachable (network error)
 * - Graceful degradation: NPM API returns non-200
 * - deriveNpmApiBase: explicit api_url, host-based, ports-based
 * - matchForwardTarget: all three strategies
 *
 * All HTTP calls use injected fetchImpl — no live network calls.
 */

import {
  NpmAdapter,
  NpmAdapterOptions,
  deriveNpmApiBase,
  matchForwardTarget,
  NpmProxyHost,
} from '../../../src/discovery/topology/npm-adapter';
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

function makeProxyHost(overrides: Partial<NpmProxyHost> & { id: number }): NpmProxyHost {
  return {
    domain_names: ['app.example.com'],
    forward_host: 'app',
    forward_port: 3000,
    forward_scheme: 'http',
    ssl_forced: false,
    enabled: true,
    ...overrides,
  };
}

/** Build a mock GraphStore. */
function makeGraphStore(opts: {
  services?: Entity[];
  containers?: Entity[];
}): import('../../../src/discovery/graph-store').GraphStore {
  const services = opts.services ?? [];
  const containers = opts.containers ?? [];
  return {
    entitiesByKind: jest.fn().mockImplementation((kind: string) => {
      if (kind === 'service') return Promise.resolve(services);
      if (kind === 'container') return Promise.resolve(containers);
      return Promise.resolve([]);
    }),
    upsertEntity: jest.fn().mockResolvedValue(undefined),
    upsertEdge: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../../../src/discovery/graph-store').GraphStore;
}

/** Build a fetch mock that returns the given proxy hosts. */
function makeFetchOk(hosts: NpmProxyHost[]) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(hosts),
  });
}

/** Build a fetch mock that throws a network error. */
function makeFetchNetworkError(msg = 'ECONNREFUSED') {
  return jest.fn().mockRejectedValue(new Error(msg));
}

/** Build a fetch mock that returns a non-200 HTTP status. */
function makeFetchHttpError(status: number) {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: jest.fn().mockResolvedValue({}),
  });
}

function makeAdapter(
  graphStore: ReturnType<typeof makeGraphStore>,
  env: NodeJS.ProcessEnv,
  opts: NpmAdapterOptions = {},
): NpmAdapter {
  return new NpmAdapter(graphStore as never, env, { clock: () => NOW, ...opts });
}

// ---------------------------------------------------------------------------
// deriveNpmApiBase
// ---------------------------------------------------------------------------

describe('deriveNpmApiBase', () => {
  it('returns api_url attribute when set', () => {
    const e = makeEntity({
      id: 'svc:npm',
      name: 'npm',
      attributes: { api_url: 'http://192.168.1.10:81/' },
    });
    expect(deriveNpmApiBase(e)).toBe('http://192.168.1.10:81');
  });

  it('builds URL from host attribute with default port 81', () => {
    const e = makeEntity({
      id: 'svc:npm',
      name: 'npm',
      attributes: { host: '192.168.1.10' },
    });
    expect(deriveNpmApiBase(e)).toBe('http://192.168.1.10:81');
  });

  it('uses management_port attribute when set', () => {
    const e = makeEntity({
      id: 'svc:npm',
      name: 'npm',
      attributes: { host: '192.168.1.10', management_port: 8181 },
    });
    expect(deriveNpmApiBase(e)).toBe('http://192.168.1.10:8181');
  });

  it('derives from ports array mapping to 81', () => {
    const e = makeEntity({
      id: 'svc:npm',
      name: 'npm',
      attributes: { ports: ['*:81->81/tcp', '*:443->443/tcp'] },
    });
    expect(deriveNpmApiBase(e)).toBe('http://localhost:81');
  });

  it('returns null when no usable info is present', () => {
    const e = makeEntity({ id: 'svc:npm', name: 'npm', attributes: {} });
    expect(deriveNpmApiBase(e)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchForwardTarget
// ---------------------------------------------------------------------------

describe('matchForwardTarget', () => {
  it('matches by exact host attribute + port (strategy 1)', () => {
    const target = makeEntity({
      id: 'svc:sonarr',
      name: 'sonarr',
      attributes: { host: 'sonarr-svc', ports: ['*:8989->8989/tcp'] },
    });
    const result = matchForwardTarget('sonarr-svc', 8989, [target]);
    expect(result).toBe(target);
  });

  it('matches by service name containing forward_host (strategy 2)', () => {
    const target = makeEntity({
      id: 'svc:radarr',
      name: 'radarr',
      attributes: {},
    });
    const result = matchForwardTarget('radarr', 7878, [target]);
    expect(result).toBe(target);
  });

  it('matches by forward_port appearing in ports array (strategy 3)', () => {
    const target = makeEntity({
      id: 'svc:plex',
      name: 'plex',
      attributes: { ports: ['*:32400->32400/tcp'] },
    });
    const result = matchForwardTarget('some-unknown-host', 32400, [target]);
    expect(result).toBe(target);
  });

  it('returns null when no match found', () => {
    const target = makeEntity({ id: 'svc:other', name: 'other', attributes: {} });
    const result = matchForwardTarget('nomatchwhatsoever', 9999, [target]);
    expect(result).toBeNull();
  });

  it('prefers strategy 1 over strategy 2', () => {
    // Two candidates: one matches by name, one matches by host+port.
    const byName = makeEntity({ id: 'svc:byname', name: 'app', attributes: {} });
    const byHost = makeEntity({
      id: 'svc:byhost',
      name: 'unrelated',
      attributes: { host: 'app', ports: ['*:3000->3000/tcp'] },
    });
    const result = matchForwardTarget('app', 3000, [byName, byHost]);
    expect(result).toBe(byHost); // strategy 1 wins for byHost
  });
});

// ---------------------------------------------------------------------------
// NpmAdapter.discover — no reverse-proxy entity in graph
// ---------------------------------------------------------------------------

describe('NpmAdapter: no reverse-proxy entity', () => {
  it('returns empty result without degraded flag when graph has no reverse-proxy', async () => {
    const graphStore = makeGraphStore({ services: [] });
    const adapter = makeAdapter(graphStore, {});
    const result = await adapter.discover();

    expect(result.degraded).toBe(false);
    expect(result.entities).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.proxyHostCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NpmAdapter.discover — no NPM_API_TOKEN
// ---------------------------------------------------------------------------

describe('NpmAdapter: no token', () => {
  it('returns degraded result when NPM_API_TOKEN is not set', async () => {
    const proxyEntity = makeEntity({
      id: 'svc:npm',
      name: 'nginx-proxy-manager',
      attributes: { role: 'reverse-proxy', host: '10.0.0.5' },
    });
    const graphStore = makeGraphStore({ services: [proxyEntity] });
    const adapter = makeAdapter(graphStore, {}); // no NPM_API_TOKEN

    const result = await adapter.discover();

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toContain('NPM_API_TOKEN');
    expect(result.entities).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NpmAdapter.discover — network error (graceful degradation)
// ---------------------------------------------------------------------------

describe('NpmAdapter: graceful degradation on network error', () => {
  it('returns degraded result when fetch throws', async () => {
    const proxyEntity = makeEntity({
      id: 'svc:npm',
      name: 'nginx-proxy-manager',
      attributes: { role: 'reverse-proxy', host: '10.0.0.5' },
    });
    const graphStore = makeGraphStore({ services: [proxyEntity] });
    const fetchImpl = makeFetchNetworkError('ECONNREFUSED 10.0.0.5:81');
    const adapter = makeAdapter(graphStore, { NPM_API_TOKEN: 'test-token' }, { fetchImpl });

    const result = await adapter.discover();

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toContain('NPM API unreachable');
    expect(result.entities).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('returns degraded result when NPM API returns HTTP 401', async () => {
    const proxyEntity = makeEntity({
      id: 'svc:npm',
      name: 'nginx-proxy-manager',
      attributes: { role: 'reverse-proxy', host: '10.0.0.5' },
    });
    const graphStore = makeGraphStore({ services: [proxyEntity] });
    const fetchImpl = makeFetchHttpError(401);
    const adapter = makeAdapter(graphStore, { NPM_API_TOKEN: 'bad-token' }, { fetchImpl });

    const result = await adapter.discover();

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toContain('NPM API unreachable');
  });
});

// ---------------------------------------------------------------------------
// NpmAdapter.discover — sample proxy-host JSON → route entities + edges
// ---------------------------------------------------------------------------

describe('NpmAdapter: sample proxy-host JSON → route entities + edges', () => {
  const proxyHost1 = makeProxyHost({
    id: 1,
    domain_names: ['sonarr.home.example.com'],
    forward_host: 'sonarr',
    forward_port: 8989,
    ssl_forced: true,
    certificate_id: 3,
    enabled: true,
  });

  const proxyHost2 = makeProxyHost({
    id: 2,
    domain_names: ['radarr.home.example.com'],
    forward_host: 'radarr',
    forward_port: 7878,
    ssl_forced: false,
    enabled: true,
  });

  const proxyHost3 = makeProxyHost({
    id: 3,
    domain_names: ['unknown.home.example.com'],
    forward_host: 'nomatchwhatsoever',
    forward_port: 9999,
    ssl_forced: false,
    enabled: false,
  });

  const proxyEntity = makeEntity({
    id: 'svc:npm',
    name: 'nginx-proxy-manager',
    attributes: { role: 'reverse-proxy', host: '10.0.0.5' },
  });

  const sonarrEntity = makeEntity({
    id: 'svc:sonarr',
    name: 'sonarr',
    attributes: { ports: ['*:8989->8989/tcp'] },
  });

  const radarrEntity = makeEntity({
    id: 'svc:radarr',
    name: 'radarr',
    attributes: { ports: ['*:7878->7878/tcp'] },
  });

  let result: Awaited<ReturnType<NpmAdapter['discover']>>;

  beforeEach(async () => {
    const graphStore = makeGraphStore({
      services: [proxyEntity, sonarrEntity, radarrEntity],
      containers: [],
    });
    const fetchImpl = makeFetchOk([proxyHost1, proxyHost2, proxyHost3]);
    const adapter = makeAdapter(graphStore, { NPM_API_TOKEN: 'test-token' }, { fetchImpl });
    result = await adapter.discover();
  });

  it('creates one route entity per domain', () => {
    expect(result.entities).toHaveLength(3); // one per proxy host
    expect(result.degraded).toBe(false);
    expect(result.proxyHostCount).toBe(3);
  });

  it('route entities have kind=route', () => {
    for (const e of result.entities) {
      expect(e.kind).toBe('route');
    }
  });

  it('route entity has correct domain attribute', () => {
    const sonarrRoute = result.entities.find((e) =>
      e.attributes['domain'] === 'sonarr.home.example.com',
    );
    expect(sonarrRoute).toBeDefined();
    expect(sonarrRoute!.attributes['forward_host']).toBe('sonarr');
    expect(sonarrRoute!.attributes['forward_port']).toBe(8989);
    expect(sonarrRoute!.attributes['ssl_forced']).toBe(true);
    expect(sonarrRoute!.attributes['has_ssl']).toBe(true);
  });

  it('route entity has correct enabled attribute', () => {
    const unknownRoute = result.entities.find((e) =>
      e.attributes['domain'] === 'unknown.home.example.com',
    );
    expect(unknownRoute).toBeDefined();
    expect(unknownRoute!.attributes['enabled']).toBe(false);
  });

  it('emits routes-to edge from route → proxy for every route', () => {
    const proxyEdges = result.edges.filter(
      (e) => e.type === 'routes-to' && e.to === proxyEntity.id,
    );
    expect(proxyEdges).toHaveLength(3); // one per route
  });

  it('emits routes-to edge from route → matched target service', () => {
    const sonarrEdge = result.edges.find(
      (e) => e.type === 'routes-to' && e.to === sonarrEntity.id,
    );
    expect(sonarrEdge).toBeDefined();

    const radarrEdge = result.edges.find(
      (e) => e.type === 'routes-to' && e.to === radarrEntity.id,
    );
    expect(radarrEdge).toBeDefined();
  });

  it('does NOT emit a routes-to edge for unmatched forward host', () => {
    const unknownEdges = result.edges.filter(
      (e) => e.type === 'routes-to' && e.from.includes('unknown.home.example.com'),
    );
    // Only the proxy edge (not a target edge).
    expect(unknownEdges).toHaveLength(1);
    expect(unknownEdges[0]!.to).toBe(proxyEntity.id);
  });

  it('route entity source is npm', () => {
    for (const e of result.entities) {
      expect(e.source).toBe('npm');
    }
  });

  it('emits a fetch call to the NPM API endpoint', async () => {
    const graphStore = makeGraphStore({ services: [proxyEntity] });
    const fetchImpl = makeFetchOk([]);
    const adapter = makeAdapter(graphStore, { NPM_API_TOKEN: 'tok' }, { fetchImpl });
    await adapter.discover();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/nginx/proxy-hosts');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });
});

// ---------------------------------------------------------------------------
// NpmAdapter.discover — multiple domains per proxy-host record
// ---------------------------------------------------------------------------

describe('NpmAdapter: multiple domains per proxy-host record', () => {
  it('creates one route entity per domain when a record has multiple domain_names', async () => {
    const proxyEntity = makeEntity({
      id: 'svc:npm',
      name: 'npm',
      attributes: { role: 'reverse-proxy', host: '10.0.0.5' },
    });
    const hostWithTwoDomains = makeProxyHost({
      id: 1,
      domain_names: ['www.example.com', 'example.com'],
    });
    const graphStore = makeGraphStore({ services: [proxyEntity] });
    const fetchImpl = makeFetchOk([hostWithTwoDomains]);
    const adapter = makeAdapter(graphStore, { NPM_API_TOKEN: 'tok' }, { fetchImpl });
    const result = await adapter.discover();

    expect(result.entities).toHaveLength(2);
    const domains = result.entities.map((e) => e.attributes['domain']);
    expect(domains).toContain('www.example.com');
    expect(domains).toContain('example.com');
  });
});
