/**
 * AlertProbe unit tests (issue #37, invariant #62).
 *
 * All HTTP calls are mocked via `AlertHttpSource`; no live network calls are made.
 *
 * Coverage:
 *   - alertSeverity: critical → P0, warning → P1, other/absent → P2
 *   - alertResource: instance → service → job → pod → alertname → "alert/unknown"
 *   - discoverEndpoint: graph query, preference order (alertmanager > prometheus),
 *     URL extraction from `attributes.url`, host+port fallback, no-match null
 *   - AlertProbe.scan (alertmanager mode): two firing alerts, empty list,
 *     resolved alert skipped, HTTP error degrades gracefully, JSON parse error
 *   - AlertProbe.scan (prometheus mode): firing alert mapped, pending skipped,
 *     HTTP error degrades gracefully
 *   - AlertProbe.scan: no endpoint configured → []
 *   - AlertProbe.scan: explicit endpointUrl used without graph
 *   - Dedup key shape
 *   - Invariant #62: no alert-name allowlist (unknown alert ingested)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  AlertProbe,
  alertSeverity,
  alertResource,
  discoverEndpoint,
  type AlertHttpSource,
  type AlertHttpResponse,
} from '../../../src/observation/probes/alert';
import type { GraphStore } from '../../../src/discovery/graph-store';
import type { Entity } from '../../../src/discovery/graph-types';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'monitoring-01';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpSource(body: unknown, ok = true, status = 200): AlertHttpSource {
  const response: AlertHttpResponse = {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
  };
}

function makeFailingHttpSource(err: Error): AlertHttpSource {
  return {
    get: jest.fn().mockRejectedValue(err),
  };
}

function makeBadJsonHttpSource(): AlertHttpSource {
  const response: AlertHttpResponse = {
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
// alertSeverity
// ---------------------------------------------------------------------------

describe('alertSeverity', () => {
  test('critical → P0', () => expect(alertSeverity('critical')).toBe('P0'));
  test('CRITICAL (uppercase) → P0', () => expect(alertSeverity('CRITICAL')).toBe('P0'));
  test('warning → P1', () => expect(alertSeverity('warning')).toBe('P1'));
  test('WARNING (uppercase) → P1', () => expect(alertSeverity('WARNING')).toBe('P1'));
  test('info → P2', () => expect(alertSeverity('info')).toBe('P2'));
  test('page → P2', () => expect(alertSeverity('page')).toBe('P2'));
  test('undefined → P2', () => expect(alertSeverity(undefined)).toBe('P2'));
  test('empty string → P2', () => expect(alertSeverity('')).toBe('P2'));
});

// ---------------------------------------------------------------------------
// alertResource
// ---------------------------------------------------------------------------

describe('alertResource', () => {
  test('instance label wins', () => {
    expect(alertResource({ instance: 'app-01:9100', job: 'node' })).toBe('instance/app-01:9100');
  });

  test('service label wins when instance absent', () => {
    expect(alertResource({ service: 'web-svc', job: 'kube' })).toBe('service/web-svc');
  });

  test('job label wins when instance and service absent', () => {
    expect(alertResource({ job: 'node-exporter' })).toBe('job/node-exporter');
  });

  test('pod label wins when instance, service, job absent', () => {
    expect(alertResource({ pod: 'web-abc', alertname: 'PodDown' })).toBe('pod/web-abc');
  });

  test('alertname fallback when all resource labels absent', () => {
    expect(alertResource({ alertname: 'Watchdog' })).toBe('alert/Watchdog');
  });

  test('"alert/unknown" when labels is undefined', () => {
    expect(alertResource(undefined)).toBe('alert/unknown');
  });

  test('"alert/unknown" when all relevant labels absent', () => {
    expect(alertResource({ unrelated: 'value' })).toBe('alert/unknown');
  });

  test('empty string labels are skipped (next priority tried)', () => {
    expect(alertResource({ instance: '', service: 'svc' })).toBe('service/svc');
  });
});

// ---------------------------------------------------------------------------
// discoverEndpoint
// ---------------------------------------------------------------------------

describe('discoverEndpoint', () => {
  test('prefers alertmanager entity over prometheus', async () => {
    const store = makeGraphStore([
      makeEntity('prom-1', { role: 'monitoring', image: 'prom/prometheus:v2.50', url: 'http://prom:9090' }),
      makeEntity('am-1', { role: 'monitoring', image: 'prom/alertmanager:v0.27', url: 'http://am:9093' }),
    ]);
    expect(await discoverEndpoint(store)).toBe('http://am:9093');
  });

  test('falls back to prometheus when no alertmanager entity', async () => {
    const store = makeGraphStore([
      makeEntity('prom-1', { role: 'monitoring', image: 'prom/prometheus:v2.50', url: 'http://prom:9090' }),
    ]);
    expect(await discoverEndpoint(store)).toBe('http://prom:9090');
  });

  test('strips trailing slash from url', async () => {
    const store = makeGraphStore([
      makeEntity('am-1', { role: 'monitoring', image: 'alertmanager', url: 'http://am:9093/' }),
    ]);
    expect(await discoverEndpoint(store)).toBe('http://am:9093');
  });

  test('constructs url from host + port when url attribute absent', async () => {
    const store = makeGraphStore([
      makeEntity('am-1', { role: 'monitoring', image: 'alertmanager:latest', host: 'am.local', port: 9093 }),
    ]);
    expect(await discoverEndpoint(store)).toBe('http://am.local:9093');
  });

  test('constructs url from host only when port absent', async () => {
    const store = makeGraphStore([
      makeEntity('am-1', { role: 'monitoring', image: 'alertmanager:latest', host: 'am.local' }),
    ]);
    expect(await discoverEndpoint(store)).toBe('http://am.local');
  });

  test('returns null when no monitoring entity with matching image', async () => {
    const store = makeGraphStore([
      makeEntity('grafana-1', { role: 'monitoring', image: 'grafana/grafana:10', url: 'http://grafana:3000' }),
    ]);
    expect(await discoverEndpoint(store)).toBeNull();
  });

  test('skips entities without role=monitoring', async () => {
    const store = makeGraphStore([
      makeEntity('am-1', { role: 'database', image: 'alertmanager', url: 'http://am:9093' }),
    ]);
    expect(await discoverEndpoint(store)).toBeNull();
  });

  test('returns null when graph store throws', async () => {
    const store = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('graph unavailable')),
    } as unknown as GraphStore;
    expect(await discoverEndpoint(store)).toBeNull();
  });

  test('returns null when entity has no url/host', async () => {
    const store = makeGraphStore([
      makeEntity('am-1', { role: 'monitoring', image: 'alertmanager:latest' }),
    ]);
    expect(await discoverEndpoint(store)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AlertProbe — construction
// ---------------------------------------------------------------------------

describe('AlertProbe construction', () => {
  test('exposes id="alert", cadence="fast", platformId', () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource([]),
    });
    expect(probe.id).toBe('alert');
    expect(probe.cadence).toBe('fast');
    expect(probe.platformId).toBe(PLATFORM);
  });
});

// ---------------------------------------------------------------------------
// AlertProbe.scan — alertmanager mode (default)
// ---------------------------------------------------------------------------

describe('AlertProbe.scan (alertmanager mode)', () => {
  test('no endpoint and no graph → returns []', async () => {
    const probe = new AlertProbe({ platformId: PLATFORM, http: makeHttpSource([]) });
    expect(await probe.scan()).toEqual([]);
  });

  test('two firing alerts from fixture → 2 prometheus_alert observations', async () => {
    const body = JSON.parse(await fs.readFile(path.join(FIX_DIR, 'alertmanager-two-alerts.json'), 'utf8')) as unknown;
    const http = makeHttpSource(body);
    const probe = new AlertProbe({ platformId: PLATFORM, http, endpointUrl: 'http://am:9093' });
    const out = await probe.scan();

    expect(out).toHaveLength(2);
    expect((http.get as jest.Mock).mock.calls[0]?.[0]).toBe('http://am:9093/api/v2/alerts?active=true');

    // First alert: critical HighMemoryUsage on instance/app-server-01:9100
    const a0 = out[0]!;
    expect(a0.pattern).toBe('prometheus_alert');
    expect(a0.severity).toBe('P0');
    expect(a0.resource).toBe('instance/app-server-01:9100');
    expect(a0.platform).toBe(PLATFORM);
    expect(a0.id).toMatch(UUID_RE);
    expect(a0.discovered_at).toMatch(ISO_RE);
    expect(a0.dedup_key).toBe(`${PLATFORM}:prometheus_alert:instance/app-server-01:9100`);
    expect(a0.details).toMatchObject({
      alertname: 'HighMemoryUsage',
      labels: expect.objectContaining({ severity: 'critical', instance: 'app-server-01:9100' }),
    });

    // Second alert: warning DiskSpaceLow on instance/nas-01:9100
    const a1 = out[1]!;
    expect(a1.pattern).toBe('prometheus_alert');
    expect(a1.severity).toBe('P1');
    expect(a1.resource).toBe('instance/nas-01:9100');
    expect(a1.dedup_key).toBe(`${PLATFORM}:prometheus_alert:instance/nas-01:9100`);
    expect(a1.details).toMatchObject({ alertname: 'DiskSpaceLow' });
  });

  test('empty alert list → returns []', async () => {
    const body = JSON.parse(await fs.readFile(path.join(FIX_DIR, 'alertmanager-empty.json'), 'utf8')) as unknown;
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource(body),
      endpointUrl: 'http://am:9093',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('resolved alert (state != "active") is skipped', async () => {
    const http = makeHttpSource([
      {
        labels: { alertname: 'Resolved', severity: 'warning', job: 'prom' },
        status: { state: 'suppressed' },
      },
    ]);
    const probe = new AlertProbe({ platformId: PLATFORM, http, endpointUrl: 'http://am:9093' });
    expect(await probe.scan()).toEqual([]);
  });

  test('alert with no state field is treated as active', async () => {
    const http = makeHttpSource([
      {
        labels: { alertname: 'NoState', severity: 'warning', instance: 'host:1234' },
        annotations: {},
      },
    ]);
    const probe = new AlertProbe({ platformId: PLATFORM, http, endpointUrl: 'http://am:9093' });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.resource).toBe('instance/host:1234');
  });

  test('network error → returns [] (graceful degradation)', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeFailingHttpSource(new Error('ECONNREFUSED')),
      endpointUrl: 'http://am:9093',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('HTTP 503 response → returns [] (graceful degradation)', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource(null, false, 503),
      endpointUrl: 'http://am:9093',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('non-array JSON response → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource({ unexpected: 'object' }),
      endpointUrl: 'http://am:9093',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('JSON parse error → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeBadJsonHttpSource(),
      endpointUrl: 'http://am:9093',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('invariant #62: unknown alert name is ingested (no allowlist)', async () => {
    const http = makeHttpSource([
      {
        labels: { alertname: 'SomeCompletelyNewAlert', severity: 'critical', instance: 'host:9100' },
        status: { state: 'active' },
        annotations: {},
      },
    ]);
    const probe = new AlertProbe({ platformId: PLATFORM, http, endpointUrl: 'http://am:9093' });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.details).toMatchObject({ alertname: 'SomeCompletelyNewAlert' });
    expect(out[0]!.severity).toBe('P0');
  });

  test('uses graph store to discover endpoint', async () => {
    const body = [
      {
        labels: { alertname: 'Test', severity: 'warning', job: 'test' },
        status: { state: 'active' },
        annotations: {},
      },
    ];
    const http = makeHttpSource(body);
    const store = makeGraphStore([
      makeEntity('am', { role: 'monitoring', image: 'alertmanager:v0.27', url: 'http://am.local:9093' }),
    ]);
    const probe = new AlertProbe({ platformId: PLATFORM, http, graphStore: store });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect((http.get as jest.Mock).mock.calls[0]?.[0]).toBe('http://am.local:9093/api/v2/alerts?active=true');
  });

  test('explicit endpointUrl overrides graph discovery', async () => {
    const http = makeHttpSource([]);
    const store = makeGraphStore([
      makeEntity('am', { role: 'monitoring', image: 'alertmanager', url: 'http://graph-am:9093' }),
    ]);
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http,
      graphStore: store,
      endpointUrl: 'http://explicit-am:9093',
    });
    await probe.scan();
    expect((http.get as jest.Mock).mock.calls[0]?.[0]).toBe('http://explicit-am:9093/api/v2/alerts?active=true');
  });

  test('trailing slash in endpointUrl is stripped', async () => {
    const http = makeHttpSource([]);
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http,
      endpointUrl: 'http://am:9093/',
    });
    await probe.scan();
    expect((http.get as jest.Mock).mock.calls[0]?.[0]).toBe('http://am:9093/api/v2/alerts?active=true');
  });
});

// ---------------------------------------------------------------------------
// AlertProbe.scan — prometheus mode
// ---------------------------------------------------------------------------

describe('AlertProbe.scan (prometheus mode)', () => {
  test('firing alert from fixture → 1 observation; pending alert skipped', async () => {
    const body = JSON.parse(await fs.readFile(path.join(FIX_DIR, 'prometheus-alerts.json'), 'utf8')) as unknown;
    const http = makeHttpSource(body);
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http,
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    const out = await probe.scan();

    expect((http.get as jest.Mock).mock.calls[0]?.[0]).toBe('http://prom:9090/api/v1/alerts');
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('prometheus_alert');
    expect(out[0]!.severity).toBe('P0');
    // pod label is highest priority present
    expect(out[0]!.resource).toBe('pod/web-deployment-7c8b9-xxxx');
    expect(out[0]!.dedup_key).toBe(`${PLATFORM}:prometheus_alert:pod/web-deployment-7c8b9-xxxx`);
    expect(out[0]!.details).toMatchObject({ alertname: 'KubePodCrashLooping' });
  });

  test('network error in prometheus mode → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeFailingHttpSource(new Error('timeout')),
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('HTTP error in prometheus mode → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource(null, false, 500),
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('prometheus response status != success → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource({ status: 'error', error: 'something went wrong' }),
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('prometheus response missing data.alerts array → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeHttpSource({ status: 'success', data: {} }),
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('JSON parse error in prometheus mode → returns []', async () => {
    const probe = new AlertProbe({
      platformId: PLATFORM,
      http: makeBadJsonHttpSource(),
      endpointUrl: 'http://prom:9090',
      api: 'prometheus',
    });
    expect(await probe.scan()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dedup key invariant
// ---------------------------------------------------------------------------

describe('AlertProbe dedup key', () => {
  test('dedup key is <platform>:<pattern>:<resource>', async () => {
    const http = makeHttpSource([
      {
        labels: { alertname: 'Watchdog', severity: 'info', job: 'prometheus' },
        status: { state: 'active' },
        annotations: {},
      },
    ]);
    const probe = new AlertProbe({ platformId: 'prod-monitoring', http, endpointUrl: 'http://am:9093' });
    const out = await probe.scan();
    expect(out[0]!.dedup_key).toBe('prod-monitoring:prometheus_alert:job/prometheus');
  });
});
