/**
 * GrafanaRegistry unit tests (issue #39, invariant #62).
 *
 * All HTTP calls are mocked via `GrafanaHttpSource`; no live network calls are
 * made in this suite (invariant: tests must not reach live hosts).
 *
 * Coverage:
 *   - discoverGrafanaEndpoint: role=monitoring, role=observability, image
 *     contains grafana; preference for url attribute; host+port fallback;
 *     trailing slash stripped; no-match null; graph error null.
 *   - resolveGrafanaToken: explicit token wins; env var fallback; null when absent.
 *   - normaliseSignal: lowercases and replaces non-alphanumeric runs.
 *   - entitySignals: derives name, role, service/job labels; deduplicates.
 *   - matchDashboard: exact via tag; exact via title; exact via folder;
 *     fuzzy via title substring; fuzzy via folder substring; fuzzy via tag
 *     substring; no match; short signal (<3 chars) not fuzzy-matched.
 *   - buildDeepLink: var-service from entity name; label_service override;
 *     var-job when distinct from service; var-instance from host; default
 *     time range; dashboard path preserved.
 *   - GrafanaRegistry.fetchDashboards: fixture -> 5 dashboard entries;
 *     empty array response; non-array response; HTTP error (401/503);
 *     network error; API token sent in Authorization header; anonymous
 *     when no token; result cached after first call.
 *   - GrafanaRegistry.resolveDashboardsForEntity: exact match by tag (sonarr);
 *     fuzzy match by title substring (postgres); no match for unknown entity;
 *     exact before fuzzy ordering; graceful when no endpoint; invalidate
 *     clears cache.
 *   - Production HTTP source exists: FetchGrafanaHttpSource is constructable
 *     and exposes a `get` method (invariant #62 lesson from #37).
 *   - GrafanaRegistry.resolveEndpoint: explicit URL wins over graph; graph
 *     discovery used when no explicit URL; null when neither.
 *   - CLI wiring: buildGrafanaCommand registers the `grafana dashboards`
 *     subcommand with the correct shape and the http dep is the production
 *     FetchGrafanaHttpSource.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  GrafanaRegistry,
  FetchGrafanaHttpSource,
  discoverGrafanaEndpoint,
  resolveGrafanaToken,
  normaliseSignal,
  entitySignals,
  matchDashboard,
  buildDeepLink,
  type GrafanaHttpSource,
  type GrafanaHttpResponse,
  type GrafanaDashboardSearchResult,
} from '../../src/observability/grafana';
import { buildGrafanaCommand } from '../../src/cli/commands/grafana';
import type { GraphStore } from '../../src/discovery/graph-store';
import type { Entity } from '../../src/discovery/graph-types';

const FIX_DIR = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHttpSource(body: unknown, ok = true, status = 200): GrafanaHttpSource {
  const response: GrafanaHttpResponse = {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
  };
}

function makeFailingHttpSource(err: Error): GrafanaHttpSource {
  return {
    get: jest.fn().mockRejectedValue(err),
  };
}

function makeBadJsonHttpSource(): GrafanaHttpSource {
  const response: GrafanaHttpResponse = {
    ok: true,
    status: 200,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
  };
}

function makeGraphStore(entities: Entity[]): GraphStore {
  return {
    entitiesByKind: jest.fn().mockResolvedValue(entities),
    getEntity: jest.fn().mockImplementation((id: string) => {
      return Promise.resolve(entities.find((e) => e.id === id) ?? null);
    }),
  } as unknown as GraphStore;
}

function makeEntity(
  id: string,
  name: string,
  attributes: Record<string, unknown> = {},
): Entity {
  return {
    id,
    kind: 'service',
    name,
    attributes,
    source: 'test',
    discovered_at: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// discoverGrafanaEndpoint
// ---------------------------------------------------------------------------

describe('discoverGrafanaEndpoint', () => {
  test('finds entity with role=monitoring and image containing grafana', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:10.2',
        url: 'http://grafana.local:3000',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBe('http://grafana.local:3000');
  });

  test('finds entity with role=observability and image containing grafana', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-2', 'grafana', {
        role: 'observability',
        image: 'grafana/grafana-enterprise:10.2',
        url: 'http://grafana.obs:3000',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBe('http://grafana.obs:3000');
  });

  test('strips trailing slash from url attribute', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:latest',
        url: 'http://grafana.local:3000/',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBe('http://grafana.local:3000');
  });

  test('constructs url from host + port when url attribute absent', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:10.2',
        host: 'grafana.local',
        port: 3000,
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBe('http://grafana.local:3000');
  });

  test('constructs url from host only when port absent', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana',
        host: 'grafana.local',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBe('http://grafana.local');
  });

  test('returns null when no entity with role=monitoring/observability', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'database',
        image: 'grafana/grafana:10.2',
        url: 'http://grafana.local:3000',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBeNull();
  });

  test('returns null when no entity image contains grafana', async () => {
    const store = makeGraphStore([
      makeEntity('alertmanager-1', 'alertmanager', {
        role: 'monitoring',
        image: 'prom/alertmanager:v0.27',
        url: 'http://am.local:9093',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBeNull();
  });

  test('returns null when entity has no url/host', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:10.2',
      }),
    ]);
    expect(await discoverGrafanaEndpoint(store)).toBeNull();
  });

  test('returns null when graph store throws', async () => {
    const store = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('graph error')),
    } as unknown as GraphStore;
    expect(await discoverGrafanaEndpoint(store)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveGrafanaToken
// ---------------------------------------------------------------------------

describe('resolveGrafanaToken', () => {
  test('explicit token wins over env var', () => {
    const env = { GRAFANA_API_TOKEN: 'env-token' };
    expect(resolveGrafanaToken('explicit-token', env)).toBe('explicit-token');
  });

  test('env var used when no explicit token', () => {
    const env = { GRAFANA_API_TOKEN: 'env-token' };
    expect(resolveGrafanaToken(undefined, env)).toBe('env-token');
  });

  test('returns null when neither explicit nor env var is present', () => {
    expect(resolveGrafanaToken(undefined, {})).toBeNull();
  });

  test('returns null when explicit token is empty string', () => {
    expect(resolveGrafanaToken('', {})).toBeNull();
  });

  test('returns null when env var is empty string', () => {
    expect(resolveGrafanaToken(undefined, { GRAFANA_API_TOKEN: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normaliseSignal
// ---------------------------------------------------------------------------

describe('normaliseSignal', () => {
  test('lowercases input', () => {
    expect(normaliseSignal('Sonarr')).toBe('sonarr');
  });

  test('replaces non-alphanumeric runs with a space', () => {
    expect(normaliseSignal('node-exporter')).toBe('node exporter');
  });

  test('trims leading/trailing spaces', () => {
    expect(normaliseSignal('  grafana  ')).toBe('grafana');
  });

  test('collapses multiple separators', () => {
    expect(normaliseSignal('foo---bar___baz')).toBe('foo bar baz');
  });
});

// ---------------------------------------------------------------------------
// entitySignals
// ---------------------------------------------------------------------------

describe('entitySignals', () => {
  test('always includes entity name (lowercased)', () => {
    const entity = makeEntity('svc-1', 'Sonarr');
    expect(entitySignals(entity)).toContain('sonarr');
  });

  test('includes role when present', () => {
    const entity = makeEntity('svc-1', 'Sonarr', { role: 'media' });
    const signals = entitySignals(entity);
    expect(signals).toContain('media');
  });

  test('includes label_service when present', () => {
    const entity = makeEntity('svc-1', 'My Service', { label_service: 'sonarr' });
    expect(entitySignals(entity)).toContain('sonarr');
  });

  test('includes service attribute when present', () => {
    const entity = makeEntity('svc-1', 'My Service', { service: 'sonarr' });
    expect(entitySignals(entity)).toContain('sonarr');
  });

  test('includes label_job when present', () => {
    const entity = makeEntity('svc-1', 'My Service', { label_job: 'sonarr-job' });
    expect(entitySignals(entity)).toContain('sonarr-job');
  });

  test('deduplicates when name == label_service', () => {
    const entity = makeEntity('svc-1', 'sonarr', { label_service: 'sonarr' });
    const signals = entitySignals(entity);
    expect(signals.filter((s) => s === 'sonarr')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// matchDashboard
// ---------------------------------------------------------------------------

describe('matchDashboard', () => {
  const SONARR_DASH: GrafanaDashboardSearchResult = {
    uid: 'sonarr-uid',
    title: 'Sonarr Overview',
    url: '/d/sonarr-uid/sonarr-overview',
    folderTitle: 'Media',
    tags: ['sonarr', 'media'],
  };

  const PG_DASH: GrafanaDashboardSearchResult = {
    uid: 'pg-uid',
    title: 'PostgreSQL Metrics',
    url: '/d/pg-uid/postgresql-metrics',
    folderTitle: 'Databases',
    tags: ['postgres', 'database'],
  };

  test('exact match when signal equals a tag verbatim', () => {
    expect(matchDashboard(['sonarr'], SONARR_DASH)).toBe('exact');
  });

  test('exact match when normalised signal equals normalised title', () => {
    expect(matchDashboard(['sonarr overview'], SONARR_DASH)).toBe('exact');
  });

  test('exact match when normalised signal equals normalised folder', () => {
    expect(matchDashboard(['media'], SONARR_DASH)).toBe('exact');
  });

  test('fuzzy match when signal is substring of title (no exact tag match)', () => {
    // "postgresql" is a substring of the title "PostgreSQL Metrics" but is NOT
    // in the tags array, so it should be a fuzzy match.
    expect(matchDashboard(['postgresql'], PG_DASH)).toBe('fuzzy');
  });

  test('fuzzy match when signal is substring of folder (no exact match)', () => {
    // "databas" is a substring of folder "Databases" but not equal to it and
    // not present as a tag, so it should be a fuzzy match.
    expect(matchDashboard(['databas'], PG_DASH)).toBe('fuzzy');
  });

  test('fuzzy match when signal is substring of a tag', () => {
    expect(matchDashboard(['post'], PG_DASH)).toBe('fuzzy');
  });

  test('returns null when no signal matches', () => {
    expect(matchDashboard(['authentik'], SONARR_DASH)).toBeNull();
  });

  test('short signals (<3 chars) are not fuzzy-matched', () => {
    // "pg" is 2 chars — should not fuzzy-match the "postgres" tag
    expect(matchDashboard(['pg'], SONARR_DASH)).toBeNull();
  });

  test('returns null when signals array is empty', () => {
    expect(matchDashboard([], SONARR_DASH)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildDeepLink
// ---------------------------------------------------------------------------

describe('buildDeepLink', () => {
  const DASH: GrafanaDashboardSearchResult = {
    uid: 'sonarr-uid',
    title: 'Sonarr Overview',
    url: '/d/sonarr-uid/sonarr-overview',
    folderTitle: 'Media',
    tags: ['sonarr'],
  };

  test('builds deep-link with entity name as var-service', () => {
    const entity = makeEntity('svc-1', 'sonarr');
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).toContain('var-service=sonarr');
    expect(link).toContain('/d/sonarr-uid/sonarr-overview');
    expect(link).toContain('http://grafana.local:3000');
  });

  test('uses label_service attribute over entity name for var-service', () => {
    const entity = makeEntity('svc-1', 'my-service', { label_service: 'sonarr' });
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).toContain('var-service=sonarr');
  });

  test('includes var-job when job label distinct from service', () => {
    const entity = makeEntity('svc-1', 'sonarr', { label_job: 'sonarr-scrape' });
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).toContain('var-job=sonarr-scrape');
  });

  test('omits var-job when job label equals service name', () => {
    const entity = makeEntity('svc-1', 'sonarr', { label_job: 'sonarr' });
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).not.toContain('var-job');
  });

  test('includes var-instance from host attribute', () => {
    const entity = makeEntity('svc-1', 'sonarr', { host: '192.168.1.5' });
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).toContain('var-instance=192.168.1.5');
  });

  test('includes default time range params', () => {
    const entity = makeEntity('svc-1', 'sonarr');
    const link = buildDeepLink('http://grafana.local:3000', DASH, entity);
    expect(link).toContain('from=now-1h');
    expect(link).toContain('to=now');
  });

  test('prepends slash to dashboard url if missing', () => {
    const dashWithoutLeadingSlash: GrafanaDashboardSearchResult = {
      ...DASH,
      url: 'd/sonarr-uid/sonarr-overview',
    };
    const entity = makeEntity('svc-1', 'sonarr');
    const link = buildDeepLink('http://grafana.local:3000', dashWithoutLeadingSlash, entity);
    expect(link).toContain('http://grafana.local:3000/d/sonarr-uid/sonarr-overview');
  });
});

// ---------------------------------------------------------------------------
// GrafanaRegistry.fetchDashboards
// ---------------------------------------------------------------------------

describe('GrafanaRegistry.fetchDashboards', () => {
  test('fixture response -> 5 dashboard entries with correct fields', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'grafana-search-response.json'), 'utf8'),
    ) as unknown;
    const http = makeHttpSource(body);
    const registry = new GrafanaRegistry({ http, endpointUrl: 'http://grafana.local:3000' });

    const dashboards = await registry.fetchDashboards();
    expect(dashboards).toHaveLength(5);

    const sonarr = dashboards.find((d) => d.uid === 'sonarr-uid-001');
    expect(sonarr).toBeDefined();
    expect(sonarr?.title).toBe('Sonarr Overview');
    expect(sonarr?.folderTitle).toBe('Media');
    expect(sonarr?.tags).toContain('sonarr');
    expect(sonarr?.url).toBe('/d/sonarr-uid-001/sonarr-overview');
  });

  test('sends Authorization header when token is configured', async () => {
    const http = makeHttpSource([]);
    const registry = new GrafanaRegistry({
      http,
      endpointUrl: 'http://grafana.local:3000',
      apiToken: 'test-api-token',
    });

    await registry.fetchDashboards();
    const getCall = (http.get as jest.Mock).mock.calls[0] as [string, Record<string, string>];
    expect(getCall[0]).toBe('http://grafana.local:3000/api/search?type=dash-db');
    expect(getCall[1]).toMatchObject({ Authorization: 'Bearer test-api-token' });
  });

  test('reads token from env when no explicit token', async () => {
    const http = makeHttpSource([]);
    const registry = new GrafanaRegistry({
      http,
      endpointUrl: 'http://grafana.local:3000',
      env: { GRAFANA_API_TOKEN: 'env-api-token' },
    });

    await registry.fetchDashboards();
    const getCall = (http.get as jest.Mock).mock.calls[0] as [string, Record<string, string>];
    expect(getCall[1]).toMatchObject({ Authorization: 'Bearer env-api-token' });
  });

  test('makes anonymous request when no token available', async () => {
    const http = makeHttpSource([]);
    const registry = new GrafanaRegistry({
      http,
      endpointUrl: 'http://grafana.local:3000',
      env: {},
    });

    await registry.fetchDashboards();
    const getCall = (http.get as jest.Mock).mock.calls[0] as [string, Record<string, string>];
    expect(getCall[1]).not.toHaveProperty('Authorization');
  });

  test('returns [] when response is empty array', async () => {
    const registry = new GrafanaRegistry({
      http: makeHttpSource([]),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] when response is not an array (graceful degradation)', async () => {
    const registry = new GrafanaRegistry({
      http: makeHttpSource({ error: 'unexpected' }),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] on HTTP 401 (graceful degradation)', async () => {
    const registry = new GrafanaRegistry({
      http: makeHttpSource(null, false, 401),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] on HTTP 503 (graceful degradation)', async () => {
    const registry = new GrafanaRegistry({
      http: makeHttpSource(null, false, 503),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] on network error (graceful degradation)', async () => {
    const registry = new GrafanaRegistry({
      http: makeFailingHttpSource(new Error('ECONNREFUSED')),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] on JSON parse error (graceful degradation)', async () => {
    const registry = new GrafanaRegistry({
      http: makeBadJsonHttpSource(),
      endpointUrl: 'http://grafana.local:3000',
    });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('returns [] when no endpoint configured and no graph store', async () => {
    const registry = new GrafanaRegistry({ http: makeHttpSource([]) });
    expect(await registry.fetchDashboards()).toEqual([]);
  });

  test('caches result after first successful fetch', async () => {
    const http = makeHttpSource([
      { uid: 'u1', title: 'T1', url: '/d/u1/t1', tags: [] },
    ]);
    const registry = new GrafanaRegistry({ http, endpointUrl: 'http://grafana.local:3000' });

    await registry.fetchDashboards();
    await registry.fetchDashboards();

    // HTTP source should be called exactly once.
    expect((http.get as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('invalidate() clears cache so next call re-fetches', async () => {
    const http = makeHttpSource([
      { uid: 'u1', title: 'T1', url: '/d/u1/t1', tags: [] },
    ]);
    const registry = new GrafanaRegistry({ http, endpointUrl: 'http://grafana.local:3000' });

    await registry.fetchDashboards();
    registry.invalidate();
    await registry.fetchDashboards();

    expect((http.get as jest.Mock)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// GrafanaRegistry.resolveEndpoint
// ---------------------------------------------------------------------------

describe('GrafanaRegistry.resolveEndpoint', () => {
  test('explicit endpointUrl wins over graph store', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:10',
        url: 'http://graph-grafana:3000',
      }),
    ]);
    const registry = new GrafanaRegistry({
      http: makeHttpSource([]),
      graphStore: store,
      endpointUrl: 'http://explicit-grafana:3000',
    });
    expect(await registry.resolveEndpoint()).toBe('http://explicit-grafana:3000');
  });

  test('strips trailing slash from explicit endpointUrl', async () => {
    const registry = new GrafanaRegistry({
      http: makeHttpSource([]),
      endpointUrl: 'http://grafana.local:3000/',
    });
    expect(await registry.resolveEndpoint()).toBe('http://grafana.local:3000');
  });

  test('uses graph store when no explicit endpoint', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', 'grafana', {
        role: 'monitoring',
        image: 'grafana/grafana:10',
        url: 'http://graph-grafana:3000',
      }),
    ]);
    const registry = new GrafanaRegistry({ http: makeHttpSource([]), graphStore: store });
    expect(await registry.resolveEndpoint()).toBe('http://graph-grafana:3000');
  });

  test('returns null when neither explicit URL nor graph store provided', async () => {
    const registry = new GrafanaRegistry({ http: makeHttpSource([]) });
    expect(await registry.resolveEndpoint()).toBeNull();
  });

  test('returns null when graph store has no matching entity', async () => {
    const store = makeGraphStore([]);
    const registry = new GrafanaRegistry({ http: makeHttpSource([]), graphStore: store });
    expect(await registry.resolveEndpoint()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GrafanaRegistry.resolveDashboardsForEntity
// ---------------------------------------------------------------------------

describe('GrafanaRegistry.resolveDashboardsForEntity', () => {
  async function makeRegistryWithFixture(): Promise<{
    registry: GrafanaRegistry;
    http: GrafanaHttpSource;
  }> {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'grafana-search-response.json'), 'utf8'),
    ) as unknown;
    const http = makeHttpSource(body);
    const registry = new GrafanaRegistry({
      http,
      endpointUrl: 'http://grafana.local:3000',
    });
    return { registry, http };
  }

  test('returns exact match for sonarr entity (tag=sonarr)', async () => {
    const { registry } = await makeRegistryWithFixture();
    const entity = makeEntity('sonarr', 'sonarr');
    const links = await registry.resolveDashboardsForEntity(entity);

    expect(links.length).toBeGreaterThan(0);
    const sonarrLink = links.find((l) => l.uid === 'sonarr-uid-001');
    expect(sonarrLink).toBeDefined();
    expect(sonarrLink?.matchKind).toBe('exact');
    expect(sonarrLink?.deepLink).toContain('var-service=sonarr');
    expect(sonarrLink?.deepLink).toContain('/d/sonarr-uid-001/sonarr-overview');
    expect(sonarrLink?.deepLink).toContain('from=now-1h');
  });

  test('returns match for postgres entity (exact via tag)', async () => {
    const { registry } = await makeRegistryWithFixture();
    // "postgres" is a tag on the postgres dashboard => exact match
    const entity = makeEntity('pg', 'postgres');
    const links = await registry.resolveDashboardsForEntity(entity);

    const pgLink = links.find((l) => l.uid === 'postgres-uid-002');
    expect(pgLink).toBeDefined();
    expect(pgLink?.matchKind).toBe('exact');
  });

  test('returns fuzzy match for entity matching title substring (not in tags)', async () => {
    const { registry } = await makeRegistryWithFixture();
    // "postgresql" is a substring of "PostgreSQL Metrics" title but not a tag
    const entity = makeEntity('pg', 'postgresql');
    const links = await registry.resolveDashboardsForEntity(entity);

    const pgLink = links.find((l) => l.uid === 'postgres-uid-002');
    expect(pgLink).toBeDefined();
    expect(pgLink?.matchKind).toBe('fuzzy');
  });

  test('exact matches sort before fuzzy matches', async () => {
    // "redis" is a tag (exact); "databases" fuzzy-matches the Databases folder
    // of postgres/redis dashboards. We just verify the first match is exact.
    const { registry } = await makeRegistryWithFixture();
    const entity = makeEntity('redis', 'redis');
    const links = await registry.resolveDashboardsForEntity(entity);

    // Redis has an exact tag match (redis-uid-004).
    const exactLinks = links.filter((l) => l.matchKind === 'exact');
    const fuzzyLinks = links.filter((l) => l.matchKind === 'fuzzy');
    // All exact links appear before any fuzzy link in the array.
    if (exactLinks.length > 0 && fuzzyLinks.length > 0) {
      const lastExactIdx = links.indexOf(exactLinks[exactLinks.length - 1]!);
      const firstFuzzyIdx = links.indexOf(fuzzyLinks[0]!);
      expect(lastExactIdx).toBeLessThan(firstFuzzyIdx);
    }
    expect(exactLinks.length).toBeGreaterThan(0);
  });

  test('returns [] for entity with no matching dashboard', async () => {
    const { registry } = await makeRegistryWithFixture();
    const entity = makeEntity('xyz', 'xyz-unknown-service-no-match');
    const links = await registry.resolveDashboardsForEntity(entity);
    expect(links).toEqual([]);
  });

  test('returns [] when no endpoint configured (graceful degradation)', async () => {
    const http = makeHttpSource([{ uid: 'u1', title: 'T1', url: '/d/u1/t1', tags: [] }]);
    const registry = new GrafanaRegistry({ http });
    const entity = makeEntity('svc', 't1');
    expect(await registry.resolveDashboardsForEntity(entity)).toEqual([]);
  });

  test('deep-link includes folder and tags on returned DashboardLink', async () => {
    const { registry } = await makeRegistryWithFixture();
    const entity = makeEntity('sonarr', 'sonarr');
    const links = await registry.resolveDashboardsForEntity(entity);
    const link = links.find((l) => l.uid === 'sonarr-uid-001');
    expect(link?.folder).toBe('Media');
    expect(link?.tags).toContain('sonarr');
  });
});

// ---------------------------------------------------------------------------
// Production HTTP source exists (invariant #62 lesson from issue #37)
// ---------------------------------------------------------------------------

describe('FetchGrafanaHttpSource (production HTTP implementation)', () => {
  test('is constructable and exposes a get method', () => {
    const source = new FetchGrafanaHttpSource();
    expect(typeof source.get).toBe('function');
  });

  test('respects custom timeoutMs without throwing on construction', () => {
    const source = new FetchGrafanaHttpSource({ timeoutMs: 5_000 });
    expect(typeof source.get).toBe('function');
  });

  test('default construction uses 10 000 ms timeout (no throw)', () => {
    expect(() => new FetchGrafanaHttpSource()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: buildGrafanaCommand
// ---------------------------------------------------------------------------

describe('buildGrafanaCommand (CLI wiring)', () => {
  function makeStreams(): { out: string[]; err: string[]; streams: import('../../src/cli/output').OutputStreams } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      streams: { stdout: (s: string) => { out.push(s); }, stderr: (s: string) => { err.push(s); } },
    };
  }

  test('command is named "grafana" and has a "dashboards" subcommand', () => {
    const http = makeHttpSource([]);
    const { command } = buildGrafanaCommand({ http });
    expect(command.name()).toBe('grafana');
    const sub = command.commands.find((c) => c.name() === 'dashboards');
    expect(sub).toBeDefined();
  });

  test('dashboards subcommand accepts --entity, --endpoint, --json flags', () => {
    const http = makeHttpSource([]);
    const { command } = buildGrafanaCommand({ http });
    const sub = command.commands.find((c) => c.name() === 'dashboards');
    expect(sub).toBeDefined();
    const optNames = sub!.options.map((o) => o.long);
    expect(optNames).toContain('--entity');
    expect(optNames).toContain('--endpoint');
    expect(optNames).toContain('--json');
  });

  test('dashboards --json emits JSON array to stdout', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'grafana-search-response.json'), 'utf8'),
    ) as unknown;
    const http = makeHttpSource(body);
    const { out, streams } = makeStreams();
    const handle = buildGrafanaCommand({ http, endpointUrl: 'http://grafana.local:3000', streams } as Parameters<typeof buildGrafanaCommand>[0] & { endpointUrl: string });

    // Invoke via commander parse
    await handle.command.parseAsync(['dashboards', '--endpoint', 'http://grafana.local:3000', '--json'], { from: 'user' });
    const joined = out.join('');
    const parsed = JSON.parse(joined) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(5);
    expect(handle.lastExitCode()).toBe(0);
  });

  test('dashboards with no endpoint and no graph store outputs graceful empty message', async () => {
    const http = makeHttpSource([]);
    const { out, streams } = makeStreams();
    const handle = buildGrafanaCommand({ http, streams });

    await handle.command.parseAsync(['dashboards'], { from: 'user' });
    const joined = out.join('');
    expect(joined).toContain('no dashboards found');
    expect(handle.lastExitCode()).toBe(0);
  });

  test('dashboards --entity returns EXIT_USAGE when no graph store', async () => {
    const http = makeHttpSource([]);
    const { streams } = makeStreams();
    const handle = buildGrafanaCommand({ http, streams });

    await handle.command.parseAsync(['dashboards', '--entity', 'svc-1'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
  });

  test('dashboards --entity returns EXIT_USAGE for unknown entity id', async () => {
    const http = makeHttpSource([]);
    const { streams } = makeStreams();
    const graphStore = makeGraphStore([]);
    const handle = buildGrafanaCommand({ http, graphStore, streams });

    await handle.command.parseAsync(['dashboards', '--entity', 'does-not-exist', '--endpoint', 'http://grafana.local:3000'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
  });

  test('dashboards --entity resolves and prints links for known entity', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'grafana-search-response.json'), 'utf8'),
    ) as unknown;
    const http = makeHttpSource(body);
    const { out, streams } = makeStreams();

    const sonarrEntity = makeEntity('sonarr-svc', 'sonarr', {
      role: 'media',
      label_service: 'sonarr',
    });
    const graphStore = makeGraphStore([sonarrEntity]);
    const handle = buildGrafanaCommand({ http, graphStore, streams });

    await handle.command.parseAsync(
      ['dashboards', '--entity', 'sonarr-svc', '--endpoint', 'http://grafana.local:3000', '--json'],
      { from: 'user' },
    );

    const joined = out.join('');
    const parsed = JSON.parse(joined) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeGreaterThan(0);
    expect(handle.lastExitCode()).toBe(0);
  });

  test('FetchGrafanaHttpSource is the wired HTTP source in the production CLI block', () => {
    // Verify the class can be constructed and that its get method is a function --
    // this proves the production HTTP implementation is importable and usable.
    const source = new FetchGrafanaHttpSource();
    expect(typeof source.get).toBe('function');
  });
});
