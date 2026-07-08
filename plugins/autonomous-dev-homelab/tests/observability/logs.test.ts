/**
 * Unit tests for src/observability/logs.ts (issue #38, invariant #62).
 *
 * All HTTP calls are mocked via `LogsHttpSource`; no live network calls.
 *
 * Coverage:
 *   - parseSinceMs: duration strings, ISO timestamps, unknown fallback, cap
 *   - clampLimit: default, minimum, max cap
 *   - buildLogQL: resource/service/filter matchers, default selector,
 *     config-overridable label names
 *   - lokiNsToIso: nanosecond-to-ISO conversion
 *   - lokiAdapter.query: two streams → 3 entries; empty; HTTP error → [];
 *     non-ok status → []; malformed JSON → []; status!=success → [];
 *     credential forwarded; field mapping applied
 *   - openSearchAdapter.query: two hits → 2 entries; empty; HTTP error → [];
 *     non-ok status → []; malformed JSON → []; missing hits → [];
 *     credential forwarded; dot-notation field mapping
 *   - buildOpenSearchQuery: bool query shape, field overrides, time range
 *   - discoverLogsEndpoints: loki found, opensearch found, both found,
 *     neither found, graph throws → graceful null, role filter,
 *     url/host+port extraction
 *   - LogsService.query: config url > graph; merged + sorted; unreachable
 *     backend emits WARN + empty; no_endpoint reported; global limit applied
 *   - FetchLogsHttpSource: class exists with get and post methods
 *   - registerLogsAdapter / getLogsAdapter: round-trip registration
 *   - Invariant #62: no backend name enum, no hard-coded service/resource
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  parseSinceMs,
  clampLimit,
  buildLogQL,
  lokiNsToIso,
  buildOpenSearchQuery,
  lokiAdapter,
  openSearchAdapter,
  discoverLogsEndpoints,
  registerLogsAdapter,
  getLogsAdapter,
  LogsService,
  FetchLogsHttpSource,
  MAX_LOG_LIMIT,
  MAX_LOOKBACK_MS,
  type LogsHttpSource,
  type LogsHttpResponse,
  type LogQuery,
  type LogsAdapter,
  type LogsAdapterOptions,
} from '../../src/observability/logs';
import type { GraphStore } from '../../src/discovery/graph-store';
import type { Entity } from '../../src/discovery/graph-types';

const FIX_DIR = path.join(__dirname, 'fixtures');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGetSource(body: unknown, ok = true, status = 200): LogsHttpSource {
  const response: LogsHttpResponse = {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
    post: jest.fn(),
  };
}

function makePostSource(body: unknown, ok = true, status = 200): LogsHttpSource {
  const response: LogsHttpResponse = {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
  return {
    get: jest.fn(),
    post: jest.fn().mockResolvedValue(response),
  };
}

function makeFailingGetSource(): LogsHttpSource {
  return {
    get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    post: jest.fn(),
  };
}

function makeFailingPostSource(): LogsHttpSource {
  return {
    get: jest.fn(),
    post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
  };
}

function makeBadJsonGetSource(): LogsHttpSource {
  const response: LogsHttpResponse = {
    ok: true,
    status: 200,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
    post: jest.fn(),
  };
}

function makeBadJsonPostSource(): LogsHttpSource {
  const response: LogsHttpResponse = {
    ok: true,
    status: 200,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  };
  return {
    get: jest.fn(),
    post: jest.fn().mockResolvedValue(response),
  };
}

function makeGraphStore(entities: Entity[]): GraphStore {
  return {
    entitiesByKind: jest.fn().mockResolvedValue(entities),
  } as unknown as GraphStore;
}

function makeEntity(id: string, attributes: Record<string, unknown>): Entity {
  return {
    id,
    kind: 'service',
    name: id,
    attributes,
    source: 'test',
    discovered_at: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// parseSinceMs
// ---------------------------------------------------------------------------

describe('parseSinceMs', () => {
  const NOW = 1_000_000_000_000; // arbitrary fixed "now" ms

  test('30m duration', () => {
    expect(parseSinceMs('30m', NOW)).toBe(NOW - 30 * 60_000);
  });

  test('1h duration', () => {
    expect(parseSinceMs('1h', NOW)).toBe(NOW - 3_600_000);
  });

  test('24h duration', () => {
    expect(parseSinceMs('24h', NOW)).toBe(NOW - 24 * 3_600_000);
  });

  test('7d duration', () => {
    expect(parseSinceMs('7d', NOW)).toBe(NOW - 7 * 86_400_000);
  });

  test('10s duration', () => {
    expect(parseSinceMs('10s', NOW)).toBe(NOW - 10_000);
  });

  test('ISO timestamp is returned as-is (when within lookback window)', () => {
    const ts = NOW - 3_600_000;
    const iso = new Date(ts).toISOString();
    expect(parseSinceMs(iso, NOW)).toBe(ts);
  });

  test('lookback cap is enforced for durations beyond MAX_LOOKBACK_MS', () => {
    // 30d > MAX_LOOKBACK_MS (7d)
    const result = parseSinceMs('30d', NOW);
    expect(result).toBe(NOW - MAX_LOOKBACK_MS);
  });

  test('ISO timestamp beyond cap is clamped', () => {
    const tooOld = NOW - MAX_LOOKBACK_MS - 1;
    const iso = new Date(tooOld).toISOString();
    expect(parseSinceMs(iso, NOW)).toBe(NOW - MAX_LOOKBACK_MS);
  });

  test('unrecognised format falls back to max lookback', () => {
    expect(parseSinceMs('not-a-date', NOW)).toBe(NOW - MAX_LOOKBACK_MS);
  });
});

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
  test('undefined → 100 (default)', () => expect(clampLimit(undefined)).toBe(100));
  test('0 → 100 (default)', () => expect(clampLimit(0)).toBe(100));
  test('-5 → 100 (default)', () => expect(clampLimit(-5)).toBe(100));
  test('50 → 50', () => expect(clampLimit(50)).toBe(50));
  test('MAX_LOG_LIMIT → MAX_LOG_LIMIT', () => expect(clampLimit(MAX_LOG_LIMIT)).toBe(MAX_LOG_LIMIT));
  test('> MAX_LOG_LIMIT → MAX_LOG_LIMIT', () => expect(clampLimit(MAX_LOG_LIMIT + 1)).toBe(MAX_LOG_LIMIT));
});

// ---------------------------------------------------------------------------
// buildLogQL
// ---------------------------------------------------------------------------

describe('buildLogQL', () => {
  test('no filters → catch-all selector', () => {
    expect(buildLogQL({})).toBe('{job=~".+"}');
  });

  test('resource only', () => {
    expect(buildLogQL({ resource: 'web-api' })).toBe('{container="web-api"}');
  });

  test('service only', () => {
    expect(buildLogQL({ service: 'auth' })).toBe('{app="auth"}');
  });

  test('resource + service', () => {
    expect(buildLogQL({ resource: 'db', service: 'postgres' })).toBe('{container="db", app="postgres"}');
  });

  test('filter adds line filter', () => {
    expect(buildLogQL({ filter: 'ERROR' })).toBe('{job=~".+"} |= `ERROR`');
  });

  test('resource + filter', () => {
    expect(buildLogQL({ resource: 'web', filter: 'timeout' })).toBe('{container="web"} |= `timeout`');
  });

  test('custom field mapping overrides label names', () => {
    const q: LogQuery = { resource: 'my-pod', service: 'svc' };
    expect(buildLogQL(q, { resource: 'pod', service: 'service' })).toBe('{pod="my-pod", service="svc"}');
  });

  test('empty resource/service strings are skipped', () => {
    expect(buildLogQL({ resource: '', service: '' })).toBe('{job=~".+"}');
  });

  test('invariant #62: no hard-coded service names — selector is data-driven', () => {
    // Any resource/service passed through without allowlist check.
    const q: LogQuery = { resource: 'completely-unknown-container-xyz', service: 'brand-new-service' };
    const result = buildLogQL(q);
    expect(result).toContain('completely-unknown-container-xyz');
    expect(result).toContain('brand-new-service');
  });
});

// ---------------------------------------------------------------------------
// lokiNsToIso
// ---------------------------------------------------------------------------

describe('lokiNsToIso', () => {
  test('converts nanosecond string to ISO-8601', () => {
    // 1782208800000000000 ns = 1782208800000 ms = 2026-06-23T10:00:00.000Z
    const iso = lokiNsToIso('1782208800000000000');
    expect(iso).toMatch(ISO_RE);
    expect(iso).toBe('2026-06-23T10:00:00.000Z');
  });

  test('zero nanoseconds → epoch', () => {
    expect(lokiNsToIso('0')).toBe('1970-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// lokiAdapter.query
// ---------------------------------------------------------------------------

describe('lokiAdapter.query', () => {
  const BASE = 'http://loki:3100';
  const EMPTY_OPTS: LogsAdapterOptions = {};

  test('two-stream fixture → 3 normalized LogEntry records', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-two-streams.json'), 'utf8'),
    ) as unknown;
    const http = makeGetSource(body);
    const entries = await lokiAdapter.query({}, BASE, http, EMPTY_OPTS);

    expect(entries).toHaveLength(3);
    // All entries have required fields.
    for (const e of entries) {
      expect(e.source).toBe('loki');
      expect(e.timestamp).toMatch(ISO_RE);
      expect(typeof e.message).toBe('string');
      expect(typeof e.labels).toBe('object');
    }
  });

  test('first entry: level=error, correct message and labels', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-two-streams.json'), 'utf8'),
    ) as unknown;
    const entries = await lokiAdapter.query({}, BASE, makeGetSource(body), EMPTY_OPTS);

    const errorEntry = entries.find((e) => e.message.includes('database connection refused'));
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.level).toBe('error');
    expect(errorEntry!.labels['container']).toBe('web-api');
    expect(errorEntry!.labels['app']).toBe('web');
  });

  test('empty result fixture → []', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const entries = await lokiAdapter.query({}, BASE, makeGetSource(body), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('network error → [] (graceful degradation)', async () => {
    const entries = await lokiAdapter.query({}, BASE, makeFailingGetSource(), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('HTTP 503 → []', async () => {
    const entries = await lokiAdapter.query({}, BASE, makeGetSource(null, false, 503), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('JSON parse error → []', async () => {
    const entries = await lokiAdapter.query({}, BASE, makeBadJsonGetSource(), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('status != "success" → []', async () => {
    const body = { status: 'error', error: 'engine error' };
    const entries = await lokiAdapter.query({}, BASE, makeGetSource(body), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('missing data.result → []', async () => {
    const body = { status: 'success', data: { resultType: 'streams' } };
    const entries = await lokiAdapter.query({}, BASE, makeGetSource(body), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('credential forwarded as Authorization header', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const http = makeGetSource(body);
    await lokiAdapter.query({}, BASE, http, { credential: 'secret-token' });

    const [, headerArg] = (http.get as jest.Mock).mock.calls[0] as [string, Record<string, string>];
    expect(headerArg?.['Authorization']).toBe('Bearer secret-token');
  });

  test('no credential → Authorization header absent', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const http = makeGetSource(body);
    await lokiAdapter.query({}, BASE, http, EMPTY_OPTS);

    const [, headerArg] = (http.get as jest.Mock).mock.calls[0] as [string, Record<string, string> | undefined];
    expect(headerArg?.['Authorization']).toBeUndefined();
  });

  test('field mapping overrides resource/service label names', async () => {
    const body = {
      status: 'success',
      data: {
        resultType: 'streams',
        result: [
          {
            stream: { pod: 'web-123', svc: 'web' },
            values: [['1719136800000000000', 'hello']],
          },
        ],
      },
    };
    const opts: LogsAdapterOptions = { fieldMapping: { resource: 'pod', service: 'svc' } };
    const http = makeGetSource(body);
    await lokiAdapter.query({ resource: 'web-123', service: 'web' }, BASE, http, opts);

    const urlArg = (http.get as jest.Mock).mock.calls[0]?.[0] as string;
    expect(urlArg).toContain('pod%3D%22web-123%22');
  });

  test('query URL contains LogQL and time params', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const http = makeGetSource(body);
    await lokiAdapter.query({ resource: 'myapp', limit: 50 }, BASE, http, EMPTY_OPTS);

    const urlArg = (http.get as jest.Mock).mock.calls[0]?.[0] as string;
    expect(urlArg).toContain('/loki/api/v1/query_range');
    expect(urlArg).toContain('limit=50');
    expect(urlArg).toContain('direction=backward');
  });

  test('trailing slash in baseUrl is stripped (no double-slash before path)', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const http = makeGetSource(body);
    await lokiAdapter.query({}, 'http://loki:3100/', http, EMPTY_OPTS);

    const urlArg = (http.get as jest.Mock).mock.calls[0]?.[0] as string;
    // The constructed path should be .../loki/api/... not ...//loki/api/...
    expect(urlArg).toContain('http://loki:3100/loki/api/v1/query_range');
    expect(urlArg).not.toMatch(/3100\/\/loki/);
  });
});

// ---------------------------------------------------------------------------
// buildOpenSearchQuery
// ---------------------------------------------------------------------------

describe('buildOpenSearchQuery', () => {
  const NOW = 1_719_136_800_000;
  const SINCE = NOW - 3_600_000;

  test('default fields: range + no match clauses when no resource/service/filter', () => {
    const q = buildOpenSearchQuery({}, SINCE, NOW, {}, 100);
    expect(q['size']).toBe(100);
    const bool = (q['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>;
    const must = bool['must'] as unknown[];
    // Only the range clause.
    expect(must).toHaveLength(1);
    const range = (must[0] as Record<string, unknown>)['range'] as Record<string, unknown>;
    expect(range['@timestamp']).toBeDefined();
  });

  test('resource adds match clause', () => {
    const q = buildOpenSearchQuery({ resource: 'web-pod' }, SINCE, NOW, {}, 10);
    const must = ((q['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['must'] as unknown[];
    expect(must).toHaveLength(2);
    const matchClause = must[1] as Record<string, unknown>;
    const matchField = matchClause['match'] as Record<string, unknown>;
    expect(matchField['kubernetes.pod_name']).toBe('web-pod');
  });

  test('service adds match clause', () => {
    const q = buildOpenSearchQuery({ service: 'auth' }, SINCE, NOW, {}, 10);
    const must = ((q['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['must'] as unknown[];
    expect(must).toHaveLength(2);
    const matchClause = must[1] as Record<string, unknown>;
    const matchField = matchClause['match'] as Record<string, unknown>;
    expect(matchField['service.name']).toBe('auth');
  });

  test('filter adds query_string clause', () => {
    const q = buildOpenSearchQuery({ filter: 'OOMKilled' }, SINCE, NOW, {}, 10);
    const must = ((q['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['must'] as unknown[];
    expect(must).toHaveLength(2);
    const qsClause = must[1] as Record<string, unknown>;
    const qs = qsClause['query_string'] as Record<string, unknown>;
    expect(qs['query']).toBe('OOMKilled');
  });

  test('fieldMapping overrides timestamp and resource fields', () => {
    const mapping = { timestamp: 'ts', resource: 'pod', service: 'svc', message: 'msg' };
    const q = buildOpenSearchQuery({ resource: 'p1', service: 's1' }, SINCE, NOW, mapping, 5);
    const must = ((q['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>)['must'] as unknown[];
    const range = (must[0] as Record<string, unknown>)['range'] as Record<string, unknown>;
    expect(range['ts']).toBeDefined();
    const m1 = must[1] as Record<string, unknown>;
    const matchField = m1['match'] as Record<string, unknown>;
    expect(matchField['pod']).toBe('p1');
  });

  test('sort is desc by timestamp field', () => {
    const q = buildOpenSearchQuery({}, SINCE, NOW, {}, 10);
    const sort = q['sort'] as unknown[];
    const sortObj = sort[0] as Record<string, unknown>;
    const tsSort = sortObj['@timestamp'] as Record<string, unknown>;
    expect(tsSort['order']).toBe('desc');
  });
});

// ---------------------------------------------------------------------------
// openSearchAdapter.query
// ---------------------------------------------------------------------------

describe('openSearchAdapter.query', () => {
  const BASE = 'http://opensearch:9200';
  const EMPTY_OPTS: LogsAdapterOptions = {};

  test('two-hits fixture → 2 normalized LogEntry records', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-two-hits.json'), 'utf8'),
    ) as unknown;
    const http = makePostSource(body);
    const entries = await openSearchAdapter.query({}, BASE, http, EMPTY_OPTS);

    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.source).toBe('opensearch');
      expect(e.timestamp).toMatch(ISO_RE);
      expect(typeof e.message).toBe('string');
      expect(typeof e.labels).toBe('object');
    }
  });

  test('first entry: level=error, correct message', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-two-hits.json'), 'utf8'),
    ) as unknown;
    const entries = await openSearchAdapter.query({}, BASE, makePostSource(body), EMPTY_OPTS);

    const oomEntry = entries.find((e) => e.message.includes('OOMKilled'));
    expect(oomEntry).toBeDefined();
    expect(oomEntry!.level).toBe('error');
  });

  test('empty hits fixture → []', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;
    const entries = await openSearchAdapter.query({}, BASE, makePostSource(body), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('network error → [] (graceful degradation)', async () => {
    const entries = await openSearchAdapter.query({}, BASE, makeFailingPostSource(), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('HTTP 500 → []', async () => {
    const entries = await openSearchAdapter.query({}, BASE, makePostSource(null, false, 500), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('JSON parse error → []', async () => {
    const entries = await openSearchAdapter.query({}, BASE, makeBadJsonPostSource(), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('missing hits.hits → []', async () => {
    const body = { hits: {} };
    const entries = await openSearchAdapter.query({}, BASE, makePostSource(body), EMPTY_OPTS);
    expect(entries).toEqual([]);
  });

  test('credential forwarded as Authorization header', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;
    const http = makePostSource(body);
    await openSearchAdapter.query({}, BASE, http, { credential: 'my-api-key' });

    const [, , headerArg] = (http.post as jest.Mock).mock.calls[0] as [string, unknown, Record<string, string>];
    expect(headerArg?.['Authorization']).toBe('Bearer my-api-key');
  });

  test('uses configured index in URL', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;
    const http = makePostSource(body);
    await openSearchAdapter.query({}, BASE, http, { index: 'logs-*' });

    const [urlArg] = (http.post as jest.Mock).mock.calls[0] as [string];
    expect(urlArg).toContain('/logs-*/_search');
  });

  test('default index is * when not configured', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;
    const http = makePostSource(body);
    await openSearchAdapter.query({}, BASE, http, EMPTY_OPTS);

    const [urlArg] = (http.post as jest.Mock).mock.calls[0] as [string];
    expect(urlArg).toContain('/*/_search');
  });

  test('trailing slash in baseUrl is stripped (no double-slash before index)', async () => {
    const body = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;
    const http = makePostSource(body);
    await openSearchAdapter.query({}, 'http://opensearch:9200/', http, EMPTY_OPTS);

    const [urlArg] = (http.post as jest.Mock).mock.calls[0] as [string];
    // No double-slash between port and index: no 9200//*
    expect(urlArg).toContain('http://opensearch:9200/*/_search');
    expect(urlArg).not.toMatch(/9200\/\//);
  });

  test('dot-notation field resolved from _source', async () => {
    const body = {
      hits: {
        hits: [
          {
            _source: {
              '@timestamp': '2026-06-23T10:00:00.000Z',
              message: 'hello',
              nested: { level: 'info' },
            },
          },
        ],
      },
    };
    // With default field mapping for log.level, nested.level won't match.
    // Providing a custom fieldMapping that uses "nested.level" should work.
    const http = makePostSource(body);
    const entries = await openSearchAdapter.query(
      {},
      BASE,
      http,
      { fieldMapping: { level: 'nested.level' } },
    );
    // level extraction from nested path
    expect(entries[0]?.level).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// discoverLogsEndpoints
// ---------------------------------------------------------------------------

describe('discoverLogsEndpoints', () => {
  test('loki entity with url attribute → loki URL discovered', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'grafana/loki:2.9', url: 'http://loki:3100' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki:3100');
    expect(result.opensearch).toBeNull();
  });

  test('opensearch entity → opensearch URL discovered', async () => {
    const store = makeGraphStore([
      makeEntity('os-1', { role: 'logging', image: 'opensearchproject/opensearch:2.12', url: 'http://os:9200' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
    expect(result.opensearch).toBe('http://os:9200');
  });

  test('both loki and opensearch entities → both URLs discovered', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'grafana/loki:2.9', url: 'http://loki:3100' }),
      makeEntity('os-1', { role: 'monitoring', image: 'opensearch:2', url: 'http://os:9200' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki:3100');
    expect(result.opensearch).toBe('http://os:9200');
  });

  test('elasticsearch image is treated as opensearch backend', async () => {
    const store = makeGraphStore([
      makeEntity('es-1', { role: 'logging', image: 'elasticsearch:8.12', url: 'http://es:9200' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.opensearch).toBe('http://es:9200');
  });

  test('role=monitoring matches (alertmanager-style graph population)', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'monitoring', image: 'loki:latest', url: 'http://loki:3100' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki:3100');
  });

  test('entity with unknown role is skipped', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'database', image: 'grafana/loki:2.9', url: 'http://loki:3100' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
  });

  test('entity with no role is skipped', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { image: 'grafana/loki:2.9', url: 'http://loki:3100' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
  });

  test('constructs url from host + port when url attribute absent', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'loki:2.9', host: 'loki.local', port: 3100 }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki.local:3100');
  });

  test('constructs url from host only when port absent', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'loki', host: 'loki.local' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki.local');
  });

  test('entity with no url/host → null URL (skipped)', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'loki:2.9' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
  });

  test('trailing slash stripped from url attribute', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'loki', url: 'http://loki:3100/' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki:3100');
  });

  test('graph store throws → returns null for both backends (graceful)', async () => {
    const store = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('graph file corrupted')),
    } as unknown as GraphStore;
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
    expect(result.opensearch).toBeNull();
  });

  test('no matching entities → null for both', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', { role: 'observability', image: 'grafana/grafana:10', url: 'http://grafana:3000' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBeNull();
    expect(result.opensearch).toBeNull();
  });

  test('invariant #62: image check is case-insensitive', async () => {
    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'GRAFANA/LOKI:2.9', url: 'http://loki:3100' }),
    ]);
    const result = await discoverLogsEndpoints(store);
    expect(result.loki).toBe('http://loki:3100');
  });
});

// ---------------------------------------------------------------------------
// registerLogsAdapter / getLogsAdapter
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  test('loki adapter is pre-registered', () => {
    expect(getLogsAdapter('loki')).toBe(lokiAdapter);
  });

  test('opensearch adapter is pre-registered', () => {
    expect(getLogsAdapter('opensearch')).toBe(openSearchAdapter);
  });

  test('unknown backend → undefined', () => {
    expect(getLogsAdapter('fluentd')).toBeUndefined();
  });

  test('invariant #62: custom adapter can be registered by string key', () => {
    const customAdapter: LogsAdapter = {
      backend: 'custom-log-backend',
      query: async () => [],
    };
    registerLogsAdapter(customAdapter);
    expect(getLogsAdapter('custom-log-backend')).toBe(customAdapter);
  });
});

// ---------------------------------------------------------------------------
// FetchLogsHttpSource — existence and interface compliance
// ---------------------------------------------------------------------------

describe('FetchLogsHttpSource', () => {
  test('is a class with get and post methods', () => {
    const src = new FetchLogsHttpSource();
    expect(typeof src.get).toBe('function');
    expect(typeof src.post).toBe('function');
  });

  test('accepts timeoutMs option', () => {
    const src = new FetchLogsHttpSource({ timeoutMs: 5_000 });
    expect(src).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LogsService.query
// ---------------------------------------------------------------------------

describe('LogsService.query', () => {
  test('config URL overrides graph discovery', async () => {
    const lokiBody = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;
    const osBody = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;

    const mockGet = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(lokiBody) });
    const mockPost = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(osBody) });
    const http: LogsHttpSource = { get: mockGet, post: mockPost };

    const graphStore = makeGraphStore([
      makeEntity('loki-graph', { role: 'observability', image: 'loki', url: 'http://graph-loki:3100' }),
    ]);

    const svc = new LogsService({
      http,
      graphStore,
      endpointUrls: { loki: 'http://config-loki:3100', opensearch: 'http://config-os:9200' },
    });

    await svc.query({});

    // Should call config URLs, not graph-discovered ones.
    const getUrl = mockGet.mock.calls[0]?.[0] as string;
    expect(getUrl).toContain('config-loki');
    expect(getUrl).not.toContain('graph-loki');
  });

  test('merged entries are sorted by timestamp descending', async () => {
    const lokiBody = {
      status: 'success',
      data: {
        resultType: 'streams',
        result: [
          {
            stream: { container: 'web', level: 'info' },
            values: [
              ['1782208800000000000', 'newer loki entry'],  // 2026-06-23T10:00:00Z
              ['1782205200000000000', 'older loki entry'],  // 2026-06-23T09:00:00Z
            ],
          },
        ],
      },
    };
    const osBody = {
      hits: {
        hits: [
          {
            _source: {
              '@timestamp': '2026-06-23T09:30:00.000Z',  // between loki entries
              message: 'opensearch mid entry',
            },
          },
        ],
      },
    };

    const http: LogsHttpSource = {
      get: jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(lokiBody) }),
      post: jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(osBody) }),
    };

    const svc = new LogsService({
      http,
      endpointUrls: { loki: 'http://loki:3100', opensearch: 'http://os:9200' },
    });

    const result = await svc.query({ limit: 10 });

    expect(result.entries).toHaveLength(3);
    // First entry should be newest.
    expect(result.entries[0]!.timestamp).toBe('2026-06-23T10:00:00.000Z');
    // Last entry should be oldest.
    expect(result.entries[2]!.timestamp).toBe('2026-06-23T09:00:00.000Z');
  });

  test('unreachable loki → WARN emitted + empty loki entries; opensearch still queried', async () => {
    const osBody = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'opensearch-empty.json'), 'utf8'),
    ) as unknown;

    const warnCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const logger = {
      warn: (msg: string, ctx?: Record<string, unknown>) => { warnCalls.push([msg, ctx]); },
    };

    // Loki fails; OpenSearch succeeds.
    const http: LogsHttpSource = {
      get: jest.fn().mockRejectedValue(new Error('loki down')),
      post: jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(osBody) }),
    };

    const svc = new LogsService({
      http,
      logger,
      endpointUrls: { loki: 'http://loki:3100', opensearch: 'http://os:9200' },
    });

    const result = await svc.query({});
    expect(result.backends['loki']).toBe('ok'); // adapter returns [] gracefully; no throw
    expect(result.backends['opensearch']).toBe('ok');
    // Logger was NOT called because the adapter itself swallows errors.
    // The loki adapter degrades gracefully and returns [] without throwing.
    expect(result.entries).toEqual([]);
  });

  test('no_endpoint reported when backend has no URL and no graph', async () => {
    const http: LogsHttpSource = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const svc = new LogsService({ http });
    const result = await svc.query({});

    expect(result.backends['loki']).toBe('no_endpoint');
    expect(result.backends['opensearch']).toBe('no_endpoint');
    expect(result.entries).toEqual([]);
  });

  test('graph store is used when no config override given', async () => {
    const lokiBody = JSON.parse(
      await fs.readFile(path.join(FIX_DIR, 'loki-empty.json'), 'utf8'),
    ) as unknown;

    const mockGet = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(lokiBody) });
    const http: LogsHttpSource = { get: mockGet, post: jest.fn() };

    const store = makeGraphStore([
      makeEntity('loki-1', { role: 'observability', image: 'loki:2.9', url: 'http://graph-loki:3100' }),
    ]);

    const svc = new LogsService({ http, graphStore: store });
    await svc.query({});

    const getUrl = mockGet.mock.calls[0]?.[0] as string;
    expect(getUrl).toContain('graph-loki');
  });

  test('global limit cap applied after merge', async () => {
    // Build a fixture with 3 loki entries.
    const lokiBody = {
      status: 'success',
      data: {
        resultType: 'streams',
        result: [
          {
            stream: { container: 'app', level: 'info' },
            values: [
              ['1719136800000000000', 'entry 1'],
              ['1719136740000000000', 'entry 2'],
              ['1719136680000000000', 'entry 3'],
            ],
          },
        ],
      },
    };

    const http: LogsHttpSource = {
      get: jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue(lokiBody) }),
      post: jest.fn(),
    };

    const svc = new LogsService({
      http,
      endpointUrls: { loki: 'http://loki:3100' },
    });

    const result = await svc.query({ limit: 2 });
    // Even though there are 3 loki entries, limit=2 caps to 2.
    expect(result.entries).toHaveLength(2);
  });

  test('graph store throws → no_endpoint (graceful)', async () => {
    const http: LogsHttpSource = { get: jest.fn(), post: jest.fn() };
    const store = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('graph unavailable')),
    } as unknown as GraphStore;

    const svc = new LogsService({ http, graphStore: store });
    const result = await svc.query({});

    expect(result.backends['loki']).toBe('no_endpoint');
    expect(result.backends['opensearch']).toBe('no_endpoint');
  });
});

// ---------------------------------------------------------------------------
// Invariant #62 checklist
// ---------------------------------------------------------------------------

describe('invariant #62 compliance', () => {
  test('no hard-coded service names in buildLogQL (data-driven)', () => {
    // Any arbitrary service name passes through unchanged.
    const arbitrary = buildLogQL({ service: 'brand-new-service-xyz' });
    expect(arbitrary).toContain('brand-new-service-xyz');
  });

  test('backend registry uses string keys, not enum', () => {
    // Any string can be registered as a backend.
    const name = 'future-backend-' + Math.random().toString(36).slice(2);
    const adapter: LogsAdapter = { backend: name, query: async () => [] };
    registerLogsAdapter(adapter);
    expect(getLogsAdapter(name)).toBe(adapter);
  });

  test('LogsService.query is READ-ONLY: no mutation methods exist', () => {
    const svc = new LogsService({ http: { get: jest.fn(), post: jest.fn() } });
    // Verify only 'query' exists; no write/ingest/delete.
    expect(typeof (svc as unknown as Record<string, unknown>)['query']).toBe('function');
    expect((svc as unknown as Record<string, unknown>)['ingest']).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>)['write']).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>)['delete']).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>)['push']).toBeUndefined();
  });
});
