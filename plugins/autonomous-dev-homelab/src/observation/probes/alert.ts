/**
 * `AlertProbe`: queries Prometheus/Alertmanager for firing alerts and maps
 * each one generically to a `prometheus_alert` observation. Implements
 * issue #37 (invariant #62).
 *
 * Endpoint discovery (invariant #62 — no hard-coded IP):
 *   1. Query the inventory graph for entities with `attributes.role` of
 *      "monitoring" whose `attributes.image` contains "alertmanager" or
 *      "prometheus". The first match's `attributes.url` (or a URL constructed
 *      from `attributes.host` + `attributes.port`) is used.
 *   2. Fall back to `opts.endpointUrl` when supplied (supports direct config
 *      for homelab setups where the graph is not yet populated).
 *   3. Return `[]` when neither is available (graceful degradation).
 *
 * Alert → Observation mapping (no allowlist; every firing alert is ingested):
 *   - `pattern`:  always `prometheus_alert`
 *   - `severity`: derived from alert label `severity`:
 *       "critical" → P0, "warning" → P1, anything else → P2
 *   - `resource`: first non-empty label in priority order:
 *       instance → service → job → pod → alertname → "alert/unknown"
 *   - `details`:  alert name + full labels map
 *
 * Connection: uses an injected `AlertHttpSource` so the probe never makes
 * live HTTP calls in tests. Production bootstrap wires in `nodeFetch`.
 *
 * Graceful degradation: any HTTP/network error → `[]` (no throw, no sentinel
 * observation, consistent with the issue spec "returns [] on unreachable").
 */

import type { Entity } from '../../discovery/graph-types.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import type { Observation, Severity } from '../types.js';
import { BaseProbe } from './base.js';

// ---------------------------------------------------------------------------
// HTTP source interface (injected; tests mock it)
// ---------------------------------------------------------------------------

/** Minimal HTTP response shape the probe consumes. */
export interface AlertHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Injected HTTP source. Implementations wrap `node-fetch`, `undici`, or a
 * test stub. Only `GET` is required.
 */
export interface AlertHttpSource {
  get(url: string): Promise<AlertHttpResponse>;
}

// ---------------------------------------------------------------------------
// Alertmanager / Prometheus wire formats
// ---------------------------------------------------------------------------

/**
 * One alert as returned by Alertmanager GET /api/v2/alerts.
 * Only the fields AlertProbe inspects are typed; the rest are carried through
 * to `details` as-is.
 */
export interface AlertmanagerAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  status?: { state?: string };
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
}

/**
 * One alert as returned by Prometheus GET /api/v1/alerts (the `data.alerts`
 * array inside `{ status: "success", data: { alerts: [...] } }`).
 */
export interface PrometheusAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
  value?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AlertProbeOptions {
  /**
   * Platform identifier this probe reports against. Typically the
   * platformId of the discovered monitoring entity, or a configured default.
   */
  platformId: string;
  /**
   * Injected HTTP source. Production code passes a thin wrapper around
   * `node-fetch`; tests pass a stub.
   */
  http: AlertHttpSource;
  /**
   * Graph store used to discover the Alertmanager/Prometheus endpoint.
   * When absent, `endpointUrl` must be supplied.
   */
  graphStore?: GraphStore;
  /**
   * Explicit endpoint URL override. When supplied, graph discovery is
   * skipped. Used when the graph is not yet populated, or for direct
   * config.
   *
   * Must be the base URL of Alertmanager (preferred) or Prometheus, without
   * a trailing slash. The probe will append the appropriate API path.
   *
   * Example: `"http://alertmanager.local:9093"`
   */
  endpointUrl?: string;
  /**
   * Which API to query when `endpointUrl` points to Prometheus rather than
   * Alertmanager. Defaults to `"alertmanager"`.
   *
   * - `"alertmanager"` → GET `<base>/api/v2/alerts?active=true`
   * - `"prometheus"`   → GET `<base>/api/v1/alerts`
   */
  api?: 'alertmanager' | 'prometheus';
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

/**
 * Map a Prometheus/Alertmanager `severity` label value to a homelab `Severity`.
 * Invariant #62: generic mapping — no alert-name check, no allowlist.
 *
 * @param label - Raw value of the `severity` alert label (may be undefined).
 * @returns `"P0"` for `"critical"`, `"P1"` for `"warning"`, `"P2"` otherwise.
 */
export function alertSeverity(label: string | undefined): Severity {
  if (label === undefined) return 'P2';
  const l = label.toLowerCase();
  if (l === 'critical') return 'P0';
  if (l === 'warning') return 'P1';
  return 'P2';
}

// ---------------------------------------------------------------------------
// Resource extraction
// ---------------------------------------------------------------------------

/**
 * Label priority order for constructing the `resource` field.
 *
 * `instance` is the most specific (host:port from node_exporter).
 * `pod` is next — in Kubernetes contexts, the pod is more specific than
 * the `job` meta-label which is the Prometheus scrape job name.
 * `service` names a Kubernetes service or Docker Swarm service.
 * `job` is the Prometheus scrape-job name (least specific of these four).
 */
const RESOURCE_LABEL_PRIORITY = ['instance', 'pod', 'service', 'job'] as const;

/**
 * Derive the `resource` value from a Prometheus/Alertmanager alert's labels.
 * Invariant #62: purely label-driven — no hard-coded service names.
 *
 * Priority: instance → service → job → pod → alertname → "alert/unknown"
 *
 * @param labels - Alert labels map.
 * @returns Resource string for use in the Observation.
 */
export function alertResource(labels: Record<string, string> | undefined): string {
  if (labels === undefined) return 'alert/unknown';
  for (const key of RESOURCE_LABEL_PRIORITY) {
    const val = labels[key];
    if (typeof val === 'string' && val !== '') {
      return `${key}/${val}`;
    }
  }
  const alertname = labels['alertname'];
  if (typeof alertname === 'string' && alertname !== '') {
    return `alert/${alertname}`;
  }
  return 'alert/unknown';
}

// ---------------------------------------------------------------------------
// Endpoint discovery from GraphStore
// ---------------------------------------------------------------------------

/**
 * Image-name substrings that identify Alertmanager/Prometheus entities.
 * Invariant #62: matched against observable attributes, not instance names.
 */
const MONITORING_IMAGE_PATTERNS = ['alertmanager', 'prometheus'] as const;

/**
 * Prefer Alertmanager over raw Prometheus. Within each preference tier,
 * prefer the first entity found in graph order.
 */
const IMAGE_PREFERENCE_ORDER = ['alertmanager', 'prometheus'] as const;

/**
 * Extract a base URL from a graph entity's attributes.
 * Tries `attributes.url` first, then constructs from `attributes.host` +
 * `attributes.port`. Returns `null` when neither is available.
 */
function entityBaseUrl(entity: Entity): string | null {
  const attrs = entity.attributes;
  if (typeof attrs['url'] === 'string' && attrs['url'] !== '') {
    return attrs['url'].replace(/\/$/, '');
  }
  const host = typeof attrs['host'] === 'string' ? attrs['host'] : '';
  const port = attrs['port'];
  if (host !== '') {
    const portStr = typeof port === 'number' ? `:${port}` : '';
    return `http://${host}${portStr}`;
  }
  return null;
}

/**
 * Discover the Alertmanager/Prometheus base URL from the graph store.
 *
 * Queries all entities with `kind="service"` and `attributes.role="monitoring"`.
 * Among those, selects the one whose image contains "alertmanager" (preferred)
 * or "prometheus" (fallback). Returns the base URL or `null` if none found.
 *
 * Invariant #62: purely attribute-driven — no hard-coded hostnames.
 */
export async function discoverEndpoint(graphStore: GraphStore): Promise<string | null> {
  let services: Entity[];
  try {
    services = await graphStore.entitiesByKind('service');
  } catch {
    return null;
  }

  const candidates = services.filter((e) => {
    if (e.attributes['role'] !== 'monitoring') return false;
    const image = typeof e.attributes['image'] === 'string'
      ? (e.attributes['image'] as string).toLowerCase()
      : '';
    return MONITORING_IMAGE_PATTERNS.some((p) => image.includes(p));
  });

  // Try preference order: alertmanager first, then prometheus.
  for (const pref of IMAGE_PREFERENCE_ORDER) {
    const match = candidates.find((e) => {
      const image = typeof e.attributes['image'] === 'string'
        ? (e.attributes['image'] as string).toLowerCase()
        : '';
      return image.includes(pref);
    });
    if (match !== undefined) {
      return entityBaseUrl(match);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// AlertProbe
// ---------------------------------------------------------------------------

/**
 * Probe that queries Alertmanager/Prometheus for firing alerts and emits
 * one `prometheus_alert` observation per firing alert. No alert allowlist;
 * every firing alert is ingested (invariant #62).
 *
 * Cadence: `fast` (5-minute interval), matching the default Alertmanager
 * evaluation cycle.
 */
export class AlertProbe extends BaseProbe {
  readonly id = 'alert';
  readonly cadence = 'fast' as const;
  readonly platformId: string;

  private readonly http: AlertHttpSource;
  private readonly graphStore: GraphStore | undefined;
  private readonly endpointUrl: string | undefined;
  private readonly api: 'alertmanager' | 'prometheus';

  constructor(opts: AlertProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.http = opts.http;
    this.graphStore = opts.graphStore;
    this.endpointUrl = opts.endpointUrl;
    this.api = opts.api ?? 'alertmanager';
  }

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  /**
   * Query Alertmanager or Prometheus for firing alerts, map each to an
   * Observation, and return them.
   *
   * Returns `[]` on any HTTP or network error (graceful degradation per
   * issue #37 acceptance criteria).
   */
  async scan(): Promise<Observation[]> {
    const base = await this.resolveEndpoint();
    if (base === null) {
      // No endpoint discoverable — degrade silently.
      return [];
    }

    if (this.api === 'prometheus') {
      return this.scanPrometheus(base);
    }
    return this.scanAlertmanager(base);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the endpoint base URL: explicit config wins over graph discovery.
   * Returns `null` when neither is available.
   */
  private async resolveEndpoint(): Promise<string | null> {
    if (this.endpointUrl !== undefined && this.endpointUrl !== '') {
      return this.endpointUrl.replace(/\/$/, '');
    }
    if (this.graphStore !== undefined) {
      return discoverEndpoint(this.graphStore);
    }
    return null;
  }

  /**
   * Query Alertmanager GET /api/v2/alerts?active=true and map results.
   */
  private async scanAlertmanager(base: string): Promise<Observation[]> {
    const url = `${base}/api/v2/alerts?active=true`;
    let resp: AlertHttpResponse;
    try {
      resp = await this.http.get(url);
    } catch {
      // Network-level failure — degrade gracefully.
      return [];
    }
    if (!resp.ok) {
      // HTTP error status — degrade gracefully.
      return [];
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return [];
    }
    if (!Array.isArray(body)) {
      return [];
    }
    return this.mapAlertmanagerAlerts(body as AlertmanagerAlert[]);
  }

  /**
   * Query Prometheus GET /api/v1/alerts and map results.
   */
  private async scanPrometheus(base: string): Promise<Observation[]> {
    const url = `${base}/api/v1/alerts`;
    let resp: AlertHttpResponse;
    try {
      resp = await this.http.get(url);
    } catch {
      return [];
    }
    if (!resp.ok) {
      return [];
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return [];
    }
    // Prometheus response: { status: "success", data: { alerts: [...] } }
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as Record<string, unknown>)['status'] !== 'success'
    ) {
      return [];
    }
    const data = (body as Record<string, unknown>)['data'];
    if (typeof data !== 'object' || data === null) {
      return [];
    }
    const alerts = (data as Record<string, unknown>)['alerts'];
    if (!Array.isArray(alerts)) {
      return [];
    }
    return this.mapPrometheusAlerts(alerts as PrometheusAlert[]);
  }

  /**
   * Map Alertmanager alerts to Observations. Only maps alerts whose `status.state`
   * is "active" or absent (i.e. firing). Resolved alerts are excluded.
   *
   * Invariant #62: no alert-name filter — every firing alert is mapped.
   */
  private mapAlertmanagerAlerts(alerts: AlertmanagerAlert[]): Observation[] {
    const out: Observation[] = [];
    for (const alert of alerts) {
      // Skip resolved alerts.
      const state = alert.status?.state;
      if (typeof state === 'string' && state !== 'active') {
        continue;
      }
      out.push(this.makeObservation({
        platform: this.platformId,
        pattern: 'prometheus_alert',
        resource: alertResource(alert.labels),
        severity: alertSeverity(alert.labels?.['severity']),
        details: {
          alertname: alert.labels?.['alertname'] ?? 'unknown',
          labels: alert.labels ?? {},
          annotations: alert.annotations ?? {},
          startsAt: alert.startsAt,
          generatorURL: alert.generatorURL,
        },
      }));
    }
    return out;
  }

  /**
   * Map Prometheus alerts to Observations. Only maps alerts whose `state`
   * is "firing". Pending/inactive alerts are excluded.
   *
   * Invariant #62: no alert-name filter.
   */
  private mapPrometheusAlerts(alerts: PrometheusAlert[]): Observation[] {
    const out: Observation[] = [];
    for (const alert of alerts) {
      // Only firing alerts.
      if (typeof alert.state === 'string' && alert.state !== 'firing') {
        continue;
      }
      out.push(this.makeObservation({
        platform: this.platformId,
        pattern: 'prometheus_alert',
        resource: alertResource(alert.labels),
        severity: alertSeverity(alert.labels?.['severity']),
        details: {
          alertname: alert.labels?.['alertname'] ?? 'unknown',
          labels: alert.labels ?? {},
          annotations: alert.annotations ?? {},
          activeAt: alert.activeAt,
        },
      }));
    }
    return out;
  }
}
