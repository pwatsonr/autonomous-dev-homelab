/**
 * ObservabilityOnboarder unit tests (issue #41, invariant #62).
 *
 * All HTTP calls are mocked via injected sources; no live network calls.
 *
 * Coverage:
 *   - entityMetricsSignals: name, service/job/app labels, deduplication
 *   - targetMatchesEntity: job/instance label match, no match, cross-signal match
 *   - checkMetricsScraping: scraped, not found, HTTP error, non-success status
 *   - buildMetricsProposal: host+port snippet, host-only, no host → undefined
 *   - discoverPrometheusEndpoint: role=monitoring, image contains prometheus,
 *       url attribute, host+port fallback, no match → null, graph error → null
 *   - ObservabilityOnboarder.onboard:
 *       all-wired → 0 gaps, 0 observations
 *       metrics-gap → 1 gap observation with correct fields
 *       logs-gap → 1 gap observation
 *       dashboards-gap → 1 gap observation
 *       all-gaps → 3 observations
 *       no Prometheus endpoint → metrics=unknown (no gap)
 *       no LogsService → logs=unknown (no gap)
 *       no GrafanaRegistry → dashboards=unknown (no gap)
 *       all backends no_endpoint in logs → logs=unknown (no gap)
 *       Prometheus HTTP error → metrics=unknown
 *   - ObservabilityOnboarder.onboardAll:
 *       skips observability-stack entities (role=monitoring/observability/logging)
 *       processes regular services
 *       graph error → empty report list
 *   - Invariant #62: generic across arbitrary entity names
 *   - Observation shape: correct pattern, platform, resource, severity, dedup_key
 *   - FaultPattern: observability_gap in types (schema + catalog cross-check)
 *   - CLI registration: buildObservabilityCommand registers `observability onboard`
 */

import {
  ObservabilityOnboarder,
  FetchPrometheusHttpSource,
  discoverPrometheusEndpoint,
  entityMetricsSignals,
  targetMatchesEntity,
  checkMetricsScraping,
  buildMetricsProposal,
  type PrometheusHttpSource,
  type PrometheusHttpResponse,
} from '../../src/observability/onboarding';
import { buildObservabilityCommand } from '../../src/cli/commands/observability';
import type { GraphStore } from '../../src/discovery/graph-store';
import type { Entity } from '../../src/discovery/graph-types';
import type { LogsService } from '../../src/observability/logs';
import type { GrafanaRegistry } from '../../src/observability/grafana';
import { FAULT_CATALOG } from '../../src/observation/fault-catalog';
import type { FaultPattern } from '../../src/observation/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

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

function makeGraphStore(entities: Entity[]): GraphStore {
  return {
    entitiesByKind: jest.fn().mockResolvedValue(entities),
    getEntity: jest.fn().mockImplementation(async (id: string) =>
      entities.find((e) => e.id === id) ?? null,
    ),
  } as unknown as GraphStore;
}

function makePrometheusHttp(
  body: unknown,
  ok = true,
  status = 200,
): PrometheusHttpSource {
  const response: PrometheusHttpResponse = {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  };
  return {
    get: jest.fn().mockResolvedValue(response),
  };
}

function makeFailingPrometheusHttp(err: Error): PrometheusHttpSource {
  return {
    get: jest.fn().mockRejectedValue(err),
  };
}

function makeLogsService(entries: unknown[], backends: Record<string, string> = { loki: 'ok' }): LogsService {
  return {
    query: jest.fn().mockResolvedValue({ entries, backends }),
  } as unknown as LogsService;
}

function makeGrafanaRegistry(links: unknown[]): GrafanaRegistry {
  return {
    resolveEndpoint: jest.fn().mockResolvedValue('http://grafana.local:3000'),
    resolveDashboardsForEntity: jest.fn().mockResolvedValue(links),
  } as unknown as GrafanaRegistry;
}

function makeGrafanaRegistryNoEndpoint(): GrafanaRegistry {
  return {
    resolveEndpoint: jest.fn().mockResolvedValue(null),
    resolveDashboardsForEntity: jest.fn().mockResolvedValue([]),
  } as unknown as GrafanaRegistry;
}

const FIXED_CLOCK = '2026-06-23T12:00:00.000Z';
const fixedClock = (): string => FIXED_CLOCK;

/** Prometheus targets response with a matching target for "my-service". */
const TARGETS_WITH_SERVICE = {
  status: 'success',
  data: {
    activeTargets: [
      { labels: { job: 'my-service', instance: 'host1:9090' }, health: 'up' },
    ],
    droppedTargets: [],
  },
};

/** Prometheus targets response with no targets. */
const TARGETS_EMPTY = {
  status: 'success',
  data: { activeTargets: [], droppedTargets: [] },
};

// ---------------------------------------------------------------------------
// entityMetricsSignals
// ---------------------------------------------------------------------------

describe('entityMetricsSignals', () => {
  test('includes entity name', () => {
    const e = makeEntity('svc1', 'my-service');
    expect(entityMetricsSignals(e)).toContain('my-service');
  });

  test('includes job label attribute', () => {
    const e = makeEntity('svc1', 'svc', { job: 'my-job' });
    const signals = entityMetricsSignals(e);
    expect(signals).toContain('my-job');
  });

  test('includes service label attribute', () => {
    const e = makeEntity('svc1', 'svc', { service: 'my-svc' });
    const signals = entityMetricsSignals(e);
    expect(signals).toContain('my-svc');
  });

  test('includes label_service attribute', () => {
    const e = makeEntity('svc1', 'svc', { label_service: 'lbl-svc' });
    const signals = entityMetricsSignals(e);
    expect(signals).toContain('lbl-svc');
  });

  test('deduplicates identical signals', () => {
    const e = makeEntity('svc1', 'my-service', { service: 'my-service' });
    const signals = entityMetricsSignals(e);
    const count = signals.filter((s) => s === 'my-service').length;
    expect(count).toBe(1);
  });

  test('lowercases signals', () => {
    const e = makeEntity('svc1', 'My-Service');
    const signals = entityMetricsSignals(e);
    expect(signals).toContain('my-service');
  });

  test('arbitrary name — invariant #62 (no allowlist)', () => {
    const e = makeEntity('xyz-99', 'some-new-unknown-service-xyz-99');
    const signals = entityMetricsSignals(e);
    expect(signals).toContain('some-new-unknown-service-xyz-99');
  });
});

// ---------------------------------------------------------------------------
// targetMatchesEntity
// ---------------------------------------------------------------------------

describe('targetMatchesEntity', () => {
  const signals = ['my-service'];

  test('matches via job label', () => {
    const target = { labels: { job: 'my-service', instance: 'host:9090' } };
    expect(targetMatchesEntity(target, signals)).toBe(true);
  });

  test('matches via instance label substring', () => {
    const target = { labels: { instance: 'my-service:9090' } };
    expect(targetMatchesEntity(target, signals)).toBe(true);
  });

  test('does not match unrelated target', () => {
    const target = { labels: { job: 'postgres', instance: 'db:5432' } };
    expect(targetMatchesEntity(target, signals)).toBe(false);
  });

  test('matches via discoveredLabels job', () => {
    const target = { discoveredLabels: { job: 'my-service' }, labels: {} };
    expect(targetMatchesEntity(target, signals)).toBe(true);
  });

  test('no labels → false', () => {
    const target = {};
    expect(targetMatchesEntity(target, signals)).toBe(false);
  });

  test('invariant #62: accepts arbitrary signal name', () => {
    const arb = ['totally-new-arbitrary-service-xyz'];
    const target = { labels: { job: 'totally-new-arbitrary-service-xyz' } };
    expect(targetMatchesEntity(target, arb)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkMetricsScraping
// ---------------------------------------------------------------------------

describe('checkMetricsScraping', () => {
  test('returns true when entity found in active targets', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp(TARGETS_WITH_SERVICE);
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBe(true);
  });

  test('returns false when entity not in active targets', async () => {
    const entity = makeEntity('svc1', 'unknown-service');
    const http = makePrometheusHttp(TARGETS_WITH_SERVICE);
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBe(false);
  });

  test('returns null on HTTP error', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp({}, false, 503);
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBeNull();
  });

  test('returns null on network error (fetch throws)', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makeFailingPrometheusHttp(new Error('ECONNREFUSED'));
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBeNull();
  });

  test('returns null when Prometheus status is not success', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp({ status: 'error', data: null });
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBeNull();
  });

  test('returns false when active targets list is empty', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp(TARGETS_EMPTY);
    const result = await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(result).toBe(false);
  });

  test('calls the correct Prometheus targets URL', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp(TARGETS_EMPTY);
    await checkMetricsScraping(entity, 'http://prom:9090', http);
    expect(http.get).toHaveBeenCalledWith('http://prom:9090/api/v1/targets');
  });

  test('strips trailing slash from base URL', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const http = makePrometheusHttp(TARGETS_EMPTY);
    await checkMetricsScraping(entity, 'http://prom:9090/', http);
    expect(http.get).toHaveBeenCalledWith('http://prom:9090/api/v1/targets');
  });
});

// ---------------------------------------------------------------------------
// buildMetricsProposal
// ---------------------------------------------------------------------------

describe('buildMetricsProposal', () => {
  test('returns snippet with host and port', () => {
    const e = makeEntity('svc1', 'my-service', { host: 'host1', port: 9090 });
    const proposal = buildMetricsProposal(e);
    expect(proposal).toBeDefined();
    expect(proposal).toContain('host1:9090');
    expect(proposal).toContain('my-service');
  });

  test('returns snippet with host only when port absent', () => {
    const e = makeEntity('svc1', 'my-service', { host: 'host1' });
    const proposal = buildMetricsProposal(e);
    expect(proposal).toBeDefined();
    expect(proposal).toContain('host1');
  });

  test('returns undefined when host is absent', () => {
    const e = makeEntity('svc1', 'my-service');
    expect(buildMetricsProposal(e)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// discoverPrometheusEndpoint
// ---------------------------------------------------------------------------

describe('discoverPrometheusEndpoint', () => {
  test('returns URL for entity with role=monitoring and image=prometheus', async () => {
    const e = makeEntity('prom1', 'prometheus', {
      role: 'monitoring',
      image: 'prom/prometheus:latest',
      url: 'http://prom:9090',
    });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBe('http://prom:9090');
  });

  test('constructs URL from host+port when url absent', async () => {
    const e = makeEntity('prom1', 'prometheus', {
      role: 'monitoring',
      image: 'prom/prometheus:latest',
      host: 'prom.local',
      port: 9090,
    });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBe('http://prom.local:9090');
  });

  test('strips trailing slash from url', async () => {
    const e = makeEntity('prom1', 'prometheus', {
      role: 'monitoring',
      image: 'prometheus',
      url: 'http://prom:9090/',
    });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBe('http://prom:9090');
  });

  test('returns null when no monitoring entity found', async () => {
    const e = makeEntity('svc1', 'my-service', { role: 'media', image: 'sonarr' });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBeNull();
  });

  test('returns null when role=monitoring but image is not prometheus', async () => {
    const e = makeEntity('graf1', 'grafana', {
      role: 'monitoring',
      image: 'grafana/grafana:latest',
      url: 'http://grafana:3000',
    });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBeNull();
  });

  test('returns null on graph error', async () => {
    const gs = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('file not found')),
    } as unknown as GraphStore;
    expect(await discoverPrometheusEndpoint(gs)).toBeNull();
  });

  test('accepts role=observability as well as role=monitoring', async () => {
    const e = makeEntity('prom1', 'prometheus', {
      role: 'observability',
      image: 'prom/prometheus:latest',
      url: 'http://prom:9090',
    });
    const gs = makeGraphStore([e]);
    expect(await discoverPrometheusEndpoint(gs)).toBe('http://prom:9090');
  });
});

// ---------------------------------------------------------------------------
// ObservabilityOnboarder.onboard
// ---------------------------------------------------------------------------

describe('ObservabilityOnboarder.onboard', () => {
  function makeFullyWiredOnboarder(entity: Entity): ObservabilityOnboarder {
    return new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({
        status: 'success',
        data: {
          activeTargets: [{ labels: { job: entity.name }, health: 'up' }],
          droppedTargets: [],
        },
      }),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([{ timestamp: '2026-01-01T00:00:00Z', message: 'log', source: 'loki', labels: {} }]),
      grafanaRegistry: makeGrafanaRegistry([{ uid: 'd1', title: 'Dashboard', deepLink: 'http://...' }]),
      platformId: 'homelab',
      clock: fixedClock,
    });
  }

  test('all-wired service → 0 gaps, 0 observations', async () => {
    const entity = makeEntity('svc1', 'my-service');
    const onboarder = makeFullyWiredOnboarder(entity);
    const report = await onboarder.onboard(entity);

    expect(report.entityId).toBe('svc1');
    expect(report.entityName).toBe('my-service');
    expect(report.channels).toHaveLength(3);
    expect(report.channels.every((c) => c.status === 'wired')).toBe(true);
    expect(report.observations).toHaveLength(0);
    expect(report.checkedAt).toBe(FIXED_CLOCK);
  });

  test('metrics-gap → 1 observation with correct fields', async () => {
    const entity = makeEntity('svc1', 'missing-service', { host: 'h1', port: 8080 });
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([{ message: 'log', timestamp: 't', source: 'loki', labels: {} }]),
      grafanaRegistry: makeGrafanaRegistry([{ uid: 'd1', deepLink: 'http://...' }]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const metricsCh = report.channels.find((c) => c.channel === 'metrics');
    expect(metricsCh?.status).toBe('gap');
    expect(report.observations).toHaveLength(1);

    const obs = report.observations[0]!;
    expect(obs.pattern).toBe('observability_gap');
    expect(obs.severity).toBe('P2');
    expect(obs.platform).toBe('homelab');
    expect(obs.resource).toBe('entity/svc1/metrics');
    expect(obs.dedup_key).toBe('homelab:observability_gap:entity/svc1/metrics');
    expect(obs.id).toMatch(UUID_RE);
    expect(obs.discovered_at).toBe(FIXED_CLOCK);
    expect(obs.details?.['entityId']).toBe('svc1');
    expect(obs.details?.['entityName']).toBe('missing-service');
    expect(obs.details?.['channel']).toBe('metrics');
    // proposal should contain host + port
    expect(typeof obs.details?.['proposal']).toBe('string');
    expect(obs.details?.['proposal']).toContain('h1:8080');
  });

  test('logs-gap → 1 observation', async () => {
    const entity = makeEntity('svc2', 'svc-no-logs');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({
        status: 'success',
        data: {
          activeTargets: [{ labels: { job: 'svc-no-logs' }, health: 'up' }],
          droppedTargets: [],
        },
      }),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),  // empty → logs gap
      grafanaRegistry: makeGrafanaRegistry([{ uid: 'd1', deepLink: 'http://...' }]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const logsCh = report.channels.find((c) => c.channel === 'logs');
    expect(logsCh?.status).toBe('gap');
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]!.resource).toBe('entity/svc2/logs');
    expect(report.observations[0]!.details?.['channel']).toBe('logs');
  });

  test('dashboards-gap → 1 observation', async () => {
    const entity = makeEntity('svc3', 'svc-no-dash', { role: 'media' });
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({
        status: 'success',
        data: { activeTargets: [{ labels: { job: 'svc-no-dash' } }], droppedTargets: [] },
      }),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([{ message: 'log', timestamp: 't', source: 'loki', labels: {} }]),
      grafanaRegistry: makeGrafanaRegistry([]),  // no dashboards → gap
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const dashCh = report.channels.find((c) => c.channel === 'dashboards');
    expect(dashCh?.status).toBe('gap');
    expect(report.observations).toHaveLength(1);
    const obs = report.observations[0]!;
    expect(obs.details?.['channel']).toBe('dashboards');
    expect(obs.details?.['role']).toBe('media');
  });

  test('all-gaps → 3 observations', async () => {
    const entity = makeEntity('svc4', 'fully-unwired-service');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    expect(report.observations).toHaveLength(3);
    const channels = report.channels.map((c) => c.channel);
    expect(channels).toContain('metrics');
    expect(channels).toContain('logs');
    expect(channels).toContain('dashboards');
    expect(report.channels.every((c) => c.status === 'gap')).toBe(true);
  });

  test('no Prometheus endpoint → metrics=unknown (no gap)', async () => {
    const entity = makeEntity('svc5', 'svc5');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      // no prometheusEndpointUrl, no graphStore → no endpoint
      logsService: makeLogsService([{ message: 'l', timestamp: 't', source: 'loki', labels: {} }]),
      grafanaRegistry: makeGrafanaRegistry([{ uid: 'd1', deepLink: 'http://...' }]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const metricsCh = report.channels.find((c) => c.channel === 'metrics');
    expect(metricsCh?.status).toBe('unknown');
    // no gap → no observation for metrics
    expect(report.observations.every((o) => o.details?.['channel'] !== 'metrics')).toBe(true);
  });

  test('no LogsService → logs=unknown (no gap)', async () => {
    const entity = makeEntity('svc6', 'svc6');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({
        status: 'success',
        data: { activeTargets: [{ labels: { job: 'svc6' } }], droppedTargets: [] },
      }),
      prometheusEndpointUrl: 'http://prom:9090',
      // no logsService
      grafanaRegistry: makeGrafanaRegistry([{ uid: 'd1', deepLink: 'http://...' }]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const logsCh = report.channels.find((c) => c.channel === 'logs');
    expect(logsCh?.status).toBe('unknown');
    expect(report.observations.every((o) => o.details?.['channel'] !== 'logs')).toBe(true);
  });

  test('no GrafanaRegistry → dashboards=unknown (no gap)', async () => {
    const entity = makeEntity('svc7', 'svc7');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({
        status: 'success',
        data: { activeTargets: [{ labels: { job: 'svc7' } }], droppedTargets: [] },
      }),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([{ message: 'l', timestamp: 't', source: 'loki', labels: {} }]),
      // no grafanaRegistry
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const dashCh = report.channels.find((c) => c.channel === 'dashboards');
    expect(dashCh?.status).toBe('unknown');
    expect(report.observations.every((o) => o.details?.['channel'] !== 'dashboards')).toBe(true);
  });

  test('all log backends no_endpoint → logs=unknown (no gap)', async () => {
    const entity = makeEntity('svc8', 'svc8');
    const logsWithNoEndpoints = makeLogsService([], { loki: 'no_endpoint', opensearch: 'no_endpoint' });
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: logsWithNoEndpoints,
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    const logsCh = report.channels.find((c) => c.channel === 'logs');
    expect(logsCh?.status).toBe('unknown');
  });

  test('Prometheus HTTP error → metrics=unknown (not check-failed via throw)', async () => {
    const entity = makeEntity('svc9', 'svc9');
    // null return from checkMetricsScraping because HTTP fails
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp({}, false, 503),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);
    const metricsCh = report.channels.find((c) => c.channel === 'metrics');
    expect(metricsCh?.status).toBe('unknown');
  });

  test('Grafana endpoint null → dashboards=unknown (no gap)', async () => {
    const entity = makeEntity('svc10', 'svc10');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistryNoEndpoint(),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);
    const dashCh = report.channels.find((c) => c.channel === 'dashboards');
    expect(dashCh?.status).toBe('unknown');
  });

  test('dedup_key is deterministic across runs for the same entity+channel', async () => {
    const entity = makeEntity('svc-dedup', 'svc-dedup');
    const makeOnboarder = (): ObservabilityOnboarder =>
      new ObservabilityOnboarder({
        prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
        prometheusEndpointUrl: 'http://prom:9090',
        logsService: makeLogsService([]),
        grafanaRegistry: makeGrafanaRegistry([]),
        platformId: 'my-platform',
        clock: fixedClock,
      });

    const r1 = await makeOnboarder().onboard(entity);
    const r2 = await makeOnboarder().onboard(entity);

    const dedups1 = r1.observations.map((o) => o.dedup_key).sort();
    const dedups2 = r2.observations.map((o) => o.dedup_key).sort();
    expect(dedups1).toEqual(dedups2);
  });
});

// ---------------------------------------------------------------------------
// ObservabilityOnboarder.onboardAll
// ---------------------------------------------------------------------------

describe('ObservabilityOnboarder.onboardAll', () => {
  test('skips observability-stack entities (role=monitoring)', async () => {
    const prom = makeEntity('prom1', 'prometheus', { role: 'monitoring', image: 'prometheus' });
    const loki = makeEntity('loki1', 'loki', { role: 'observability', image: 'loki' });
    const logEntity = makeEntity('fl1', 'fluentd', { role: 'logging', image: 'fluentd' });
    const gs = makeGraphStore([prom, loki, logEntity]);

    const onboarder = new ObservabilityOnboarder({
      graphStore: gs,
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    // All three are infra — none should be onboarded.
    expect(reports).toHaveLength(0);
  });

  test('processes regular services (no infra role)', async () => {
    const svc = makeEntity('svc1', 'my-app', { role: 'media' });
    const prom = makeEntity('prom1', 'prometheus', { role: 'monitoring', image: 'prometheus' });
    const gs = makeGraphStore([svc, prom]);

    const onboarder = new ObservabilityOnboarder({
      graphStore: gs,
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    // Only svc1 processed (prom1 skipped).
    expect(reports).toHaveLength(1);
    expect(reports[0]!.entityId).toBe('svc1');
  });

  test('entities with no role attribute are processed (invariant #62)', async () => {
    // A service that matched no role catalog pattern — still onboarded.
    const svc = makeEntity('new-svc', 'new-service-xyz', {});
    const gs = makeGraphStore([svc]);

    const onboarder = new ObservabilityOnboarder({
      graphStore: gs,
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.entityName).toBe('new-service-xyz');
  });

  test('graph error → empty report list', async () => {
    const gs = {
      entitiesByKind: jest.fn().mockRejectedValue(new Error('ENOENT')),
    } as unknown as GraphStore;

    const onboarder = new ObservabilityOnboarder({
      graphStore: gs,
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    expect(reports).toHaveLength(0);
  });

  test('no graphStore → empty report list', async () => {
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    expect(reports).toHaveLength(0);
  });

  test('multiple services produce one report each', async () => {
    const svcs = ['svc-a', 'svc-b', 'svc-c'].map((n) => makeEntity(n, n));
    const gs = makeGraphStore(svcs);

    const onboarder = new ObservabilityOnboarder({
      graphStore: gs,
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });

    const reports = await onboarder.onboardAll();
    expect(reports).toHaveLength(3);
    const names = reports.map((r) => r.entityName).sort();
    expect(names).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });
});

// ---------------------------------------------------------------------------
// Invariant #62: generic across arbitrary service names
// ---------------------------------------------------------------------------

describe('invariant #62: generic onboarding (no hard-coded names)', () => {
  test('arbitrary new service name is onboarded with full gap when no infra', async () => {
    const entity = makeEntity(
      'brand-new-svc-xyz',
      'brand-new-svc-xyz',
      { role: 'custom-role-that-did-not-exist-at-build-time' },
    );
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    // No code change was needed — just a new entity in the graph.
    expect(report.entityName).toBe('brand-new-svc-xyz');
    expect(report.observations).toHaveLength(3);
    expect(report.observations.every((o) => o.pattern === 'observability_gap')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FaultPattern: observability_gap — schema + catalog cross-check
// ---------------------------------------------------------------------------

describe('observability_gap fault pattern', () => {
  test('observability_gap exists in FAULT_CATALOG', () => {
    const entry = FAULT_CATALOG['observability_gap' as FaultPattern];
    expect(entry).toBeDefined();
    expect(entry?.pattern).toBe('observability_gap');
    expect(entry?.severity).toBe('P2');
    expect(entry?.destructiveness).toBe('read-only');
  });

  test('observation produced by onboarder has correct pattern value', async () => {
    const entity = makeEntity('svc-gap', 'svc-gap');
    const onboarder = new ObservabilityOnboarder({
      prometheusHttp: makePrometheusHttp(TARGETS_EMPTY),
      prometheusEndpointUrl: 'http://prom:9090',
      logsService: makeLogsService([]),
      grafanaRegistry: makeGrafanaRegistry([]),
      platformId: 'homelab',
      clock: fixedClock,
    });
    const report = await onboarder.onboard(entity);

    expect(report.observations.length).toBeGreaterThan(0);
    for (const obs of report.observations) {
      expect(obs.pattern).toBe('observability_gap');
      expect(obs.id).toMatch(UUID_RE);
      expect(obs.discovered_at).toMatch(ISO_RE);
    }
  });
});

// ---------------------------------------------------------------------------
// FetchPrometheusHttpSource: constructable + has get method (invariant #62
// lesson from issue #37 — production source must exist, not just a stub)
// ---------------------------------------------------------------------------

describe('FetchPrometheusHttpSource production source', () => {
  test('is constructable and exposes a get method', () => {
    const src = new FetchPrometheusHttpSource();
    expect(typeof src.get).toBe('function');
  });

  test('accepts custom timeoutMs', () => {
    const src = new FetchPrometheusHttpSource({ timeoutMs: 5000 });
    expect(typeof src.get).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// CLI registration proof
// ---------------------------------------------------------------------------

describe('CLI registration: buildObservabilityCommand', () => {
  test('registers the observability command group', () => {
    const handle = buildObservabilityCommand({ streams: { stdout: jest.fn(), stderr: jest.fn() } });
    expect(handle.command.name()).toBe('observability');
  });

  test('observability command has an "onboard" subcommand', () => {
    const handle = buildObservabilityCommand({});
    const subNames = handle.command.commands.map((c) => c.name());
    expect(subNames).toContain('onboard');
  });

  test('lastExitCode returns 0 initially', () => {
    const handle = buildObservabilityCommand({});
    expect(handle.lastExitCode()).toBe(0);
  });

  test('onboard subcommand has --entity option', () => {
    const handle = buildObservabilityCommand({});
    const onboard = handle.command.commands.find((c) => c.name() === 'onboard')!;
    const optNames = onboard.options.map((o) => o.long);
    expect(optNames).toContain('--entity');
  });

  test('onboard subcommand has --json option', () => {
    const handle = buildObservabilityCommand({});
    const onboard = handle.command.commands.find((c) => c.name() === 'onboard')!;
    const optNames = onboard.options.map((o) => o.long);
    expect(optNames).toContain('--json');
  });
});

// ---------------------------------------------------------------------------
// CLI action: --json output
// ---------------------------------------------------------------------------

describe('CLI observability onboard --json', () => {
  test('command is buildable and has correct name (CLI registration sanity)', () => {
    // The command internally constructs FetchPrometheusHttpSource; no injection
    // is required at this level. Verify the command is wired correctly.
    const handle = buildObservabilityCommand({
      graphStore: makeGraphStore([]),
      prometheusEndpointUrl: 'http://prom:9090',
      streams: { stdout: jest.fn(), stderr: jest.fn() },
    });
    expect(handle.command.name()).toBe('observability');
    expect(handle.lastExitCode()).toBe(0);
  });

  test('emits "no service entities found" when graph is empty', async () => {
    const gs = makeGraphStore([]);
    const out: string[] = [];
    const handle = buildObservabilityCommand({
      graphStore: gs,
      streams: { stdout: (s: string) => out.push(s), stderr: jest.fn() },
    });

    // Parse and invoke the action.
    await handle.command.parseAsync(['onboard'], { from: 'user' });
    const combined = out.join('');
    expect(combined).toContain('no service entities found');
  });

  test('--entity not found → EXIT_USAGE', async () => {
    const gs = makeGraphStore([]);
    const errOut: string[] = [];
    const handle = buildObservabilityCommand({
      graphStore: gs,
      streams: { stdout: jest.fn(), stderr: (s: string) => errOut.push(s) },
    });

    await handle.command.parseAsync(['onboard', '--entity', 'missing-id'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(errOut.join('')).toContain('missing-id');
  });

  test('--entity without graphStore → EXIT_USAGE', async () => {
    const errOut: string[] = [];
    const handle = buildObservabilityCommand({
      streams: { stdout: jest.fn(), stderr: (s: string) => errOut.push(s) },
    });

    await handle.command.parseAsync(['onboard', '--entity', 'some-id'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
  });
});
