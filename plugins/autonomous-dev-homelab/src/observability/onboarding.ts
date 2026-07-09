/**
 * Observability onboarding for the homelab control plane.
 * Implements GitHub issue #41, invariant #62 (dynamic-first).
 *
 * Design:
 *   `ObservabilityOnboarder` inspects a single service entity (from the
 *   inventory graph) and determines which of the three observability channels
 *   it is already wired into:
 *
 *     - Metrics:    Is the service scraped by Prometheus?
 *                   Queried generically via GET /api/v1/targets; matches the
 *                   entity's name/job/labels against target metadata — no
 *                   hard-coded service names.
 *
 *     - Logs:       Can log entries be found for this service via the logs
 *                   adapter (#38)?  A probe query with a 1 h lookback that
 *                   returns ≥ 1 entry counts as "queryable".
 *
 *     - Dashboards: Does the Grafana registry (#39) resolve ≥ 1 dashboard
 *                   for this entity?
 *
 *   For each missing channel an `observability_gap` observation is produced
 *   (pattern added to types.ts / fault-catalog.ts / schema in this same
 *   commit). Where a concrete remediation action can be expressed generically
 *   (e.g. a Prometheus file-SD snippet), a `proposal` is included in
 *   `details` — but the onboarder never mutates external systems.
 *
 *   All three checks are independent: a failure in one never aborts the
 *   others. Unreachable backends are recorded as gaps only when the backend
 *   was discoverable (missing endpoint ≠ gap — we just can't check).
 *
 * Invariant #62 compliance:
 *   - No hard-coded service names anywhere. Every decision is driven by the
 *     entity's `name`, `attributes.role`, and attribute labels.
 *   - Prometheus targets are matched generically (entity name vs job/instance
 *     labels). A new service is onboarded on the next run with no code change.
 *   - Metrics proposal emits a generic Prometheus file-SD snippet keyed on
 *     the entity's observed attributes (host, port, name) — not a fixed map.
 *   - All HTTP calls are injected (`PrometheusHttpSource`) so tests never hit
 *     the network. `FetchPrometheusHttpSource` is the production implementation.
 */

import { randomUUID } from 'node:crypto';
import type { Entity } from '../discovery/graph-types.js';
import type { GraphStore } from '../discovery/graph-store.js';
import type { Observation } from '../observation/types.js';
import { LogsService } from './logs.js';
import { GrafanaRegistry } from './grafana.js';

// ---------------------------------------------------------------------------
// HTTP source for Prometheus (injected; tests mock it)
// ---------------------------------------------------------------------------

/** Minimal HTTP response shape the Prometheus client consumes. */
export interface PrometheusHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Injected HTTP source for Prometheus API queries. Tests supply a stub;
 * production wires `FetchPrometheusHttpSource`.
 */
export interface PrometheusHttpSource {
  /**
   * Issue a GET request to `url` with optional headers.
   *
   * @param url     - Fully-qualified URL.
   * @param headers - Optional request headers.
   */
  get(url: string, headers?: Record<string, string>): Promise<PrometheusHttpResponse>;
}

/** Default timeout for Prometheus HTTP requests. */
const PROMETHEUS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Production `PrometheusHttpSource` backed by the global `fetch` API.
 * Uses `AbortSignal.timeout` so a slow endpoint never blocks indefinitely.
 *
 * Usage:
 * ```ts
 * const onboarder = new ObservabilityOnboarder({
 *   prometheusHttp: new FetchPrometheusHttpSource(),
 *   ...
 * });
 * ```
 */
export class FetchPrometheusHttpSource implements PrometheusHttpSource {
  private readonly timeoutMs: number;

  /**
   * @param opts.timeoutMs - Request timeout in milliseconds (default 10 000).
   */
  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? PROMETHEUS_FETCH_TIMEOUT_MS;
  }

  /**
   * Issue a GET request and return a minimal response wrapper.
   *
   * @param url     - Fully-qualified URL.
   * @param headers - Optional request headers.
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<PrometheusHttpResponse> {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Accept: 'application/json', ...headers },
    });
    return {
      ok: response.ok,
      status: response.status,
      json: (): Promise<unknown> => response.json() as Promise<unknown>,
    };
  }
}

// ---------------------------------------------------------------------------
// Prometheus endpoint discovery (invariant #62)
// ---------------------------------------------------------------------------

/**
 * Image substrings that identify a Prometheus entity in the graph.
 * Invariant #62: matched against `attributes.image`, never instance names.
 */
const PROMETHEUS_IMAGE_PATTERNS = ['prometheus'] as const;

/**
 * Roles that monitoring entities carry in the graph.
 */
const MONITORING_ROLES = new Set(['monitoring', 'observability']);

/**
 * Extract a base URL from a graph entity's attributes.
 * Tries `attributes.url` first, then constructs from `attributes.host` +
 * `attributes.port`. Returns `null` when neither is available.
 *
 * @param entity - Graph entity.
 */
function entityBaseUrl(entity: Entity): string | null {
  const attrs = entity.attributes;
  if (typeof attrs['url'] === 'string' && attrs['url'] !== '') {
    return (attrs['url'] as string).replace(/\/$/, '');
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
 * Discover the Prometheus base URL generically from the inventory graph.
 *
 * Queries all entities with `kind="service"` whose `attributes.role` is
 * "monitoring" or "observability" AND whose `attributes.image` contains
 * "prometheus". Returns the first match's base URL, or `null` if none found.
 *
 * Invariant #62: purely attribute-driven — no hard-coded hostnames or IPs.
 *
 * @param graphStore - The graph store to query.
 * @returns Base URL (no trailing slash) or `null`.
 */
export async function discoverPrometheusEndpoint(graphStore: GraphStore): Promise<string | null> {
  let services: Entity[];
  try {
    services = await graphStore.entitiesByKind('service');
  } catch {
    return null;
  }

  for (const entity of services) {
    const role = entity.attributes['role'];
    if (typeof role !== 'string' || !MONITORING_ROLES.has(role)) continue;

    const image =
      typeof entity.attributes['image'] === 'string'
        ? (entity.attributes['image'] as string).toLowerCase()
        : '';
    if (!PROMETHEUS_IMAGE_PATTERNS.some((p) => image.includes(p))) continue;

    const url = entityBaseUrl(entity);
    if (url !== null) return url;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prometheus targets check (generic — no hard-coded service names)
// ---------------------------------------------------------------------------

/**
 * Wire-format for one Prometheus target as returned by `/api/v1/targets`.
 */
interface PrometheusTarget {
  labels?: Record<string, string>;
  discoveredLabels?: Record<string, string>;
  scrapePool?: string;
  scrapeUrl?: string;
  health?: string;
}

/** Response shape from `GET /api/v1/targets`. */
interface PrometheusTargetsResponse {
  status?: string;
  data?: {
    activeTargets?: PrometheusTarget[];
    droppedTargets?: PrometheusTarget[];
  };
}

/**
 * Derive the set of signal strings we use to match an entity against
 * Prometheus target labels. Invariant #62: no hardcoded service names —
 * signals come from the entity's own attributes.
 *
 * @param entity - Service entity from the graph.
 * @returns Array of lowercase signal strings.
 */
export function entityMetricsSignals(entity: Entity): string[] {
  const raw: string[] = [entity.name];

  // Service/job/app labels are primary Prometheus routing signals.
  for (const key of ['service', 'job', 'app', 'label_service', 'label_job', 'label_app'] as const) {
    const val = entity.attributes[key];
    if (typeof val === 'string' && val !== '') {
      raw.push(val);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const lower = s.toLowerCase().trim();
    if (lower !== '' && !seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

/**
 * Check whether a Prometheus target matches any entity signal.
 * Matches against the `job` and `instance` labels of the target.
 * Invariant #62: purely label-driven — no allowlist of service names.
 *
 * @param target  - Prometheus target entry.
 * @param signals - Entity signals (lowercased) from {@link entityMetricsSignals}.
 * @returns True when the target is associated with this entity.
 */
export function targetMatchesEntity(
  target: PrometheusTarget,
  signals: string[],
): boolean {
  const allLabels: Record<string, string> = {
    ...(target.discoveredLabels ?? {}),
    ...(target.labels ?? {}),
  };

  // Check job and instance labels primarily; also check __address__ for a
  // host:port match as a secondary heuristic.
  const candidateValues: string[] = [];
  for (const key of ['job', 'instance', '__address__', 'app', 'service'] as const) {
    const val = allLabels[key];
    if (typeof val === 'string' && val !== '') {
      candidateValues.push(val.toLowerCase());
    }
  }

  for (const signal of signals) {
    for (const val of candidateValues) {
      if (val.includes(signal) || signal.includes(val)) return true;
    }
  }

  return false;
}

/**
 * Query Prometheus `GET /api/v1/targets` and check whether the entity is
 * represented in the active target list. Returns `true` when scraped,
 * `false` when not found, and `null` when the endpoint is unreachable or
 * returns an error (i.e. we cannot determine the status — no gap recorded).
 *
 * Invariant #62: purely label/attribute-driven; no hard-coded service names.
 *
 * @param entity     - Service entity to check.
 * @param promBase   - Prometheus base URL.
 * @param http       - Injected HTTP source.
 * @returns `true` = scraped, `false` = not found, `null` = cannot determine.
 */
export async function checkMetricsScraping(
  entity: Entity,
  promBase: string,
  http: PrometheusHttpSource,
): Promise<boolean | null> {
  const url = `${promBase.replace(/\/$/, '')}/api/v1/targets`;
  let resp: PrometheusHttpResponse;
  try {
    resp = await http.get(url);
  } catch {
    // Network error — cannot determine.
    return null;
  }

  if (!resp.ok) {
    // HTTP error — cannot determine.
    return null;
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return null;
  }

  const parsed = body as PrometheusTargetsResponse;
  if (parsed?.status !== 'success') return null;

  const activeTargets = parsed?.data?.activeTargets;
  if (!Array.isArray(activeTargets)) return null;

  const signals = entityMetricsSignals(entity);
  if (signals.length === 0) return false;

  return (activeTargets as PrometheusTarget[]).some((t) => targetMatchesEntity(t, signals));
}

/**
 * Build a generic Prometheus file-SD proposal snippet for a service entity.
 * Uses only the entity's discovered attributes — no hard-coded names.
 * Emitted as the `proposal` field in gap observation details.
 *
 * @param entity - Service entity to generate the snippet for.
 * @returns YAML-like string proposal, or `undefined` when insufficient info.
 */
export function buildMetricsProposal(entity: Entity): string | undefined {
  const host = typeof entity.attributes['host'] === 'string'
    ? entity.attributes['host']
    : '';
  const port = typeof entity.attributes['port'] === 'number'
    ? entity.attributes['port']
    : typeof entity.attributes['metrics_port'] === 'number'
    ? entity.attributes['metrics_port']
    : null;
  const name = entity.name;

  if (host === '') return undefined;

  const target = port !== null ? `${host}:${port}` : host;
  return (
    `# Add to Prometheus file-SD config (e.g. /etc/prometheus/targets/${name}.json):\n` +
    `[{ "targets": ["${target}"], "labels": { "job": "${name}" } }]`
  );
}

// ---------------------------------------------------------------------------
// OnboardingChannel + OnboardingReport
// ---------------------------------------------------------------------------

/**
 * The three observability channels that must be wired for a service.
 * Open string union so future channels can be added without touching the union
 * definition (invariant #62).
 */
export type OnboardingChannel = 'metrics' | 'logs' | 'dashboards';

/**
 * Status of one channel for a single entity.
 *   `wired`          - channel is configured and queryable.
 *   `gap`            - channel is missing; an observation was emitted.
 *   `unknown`        - endpoint not discoverable; check skipped (no gap emitted).
 *   `check-failed`   - endpoint reachable but check returned an unexpected error.
 */
export type ChannelStatus = 'wired' | 'gap' | 'unknown' | 'check-failed';

/** Per-channel result for a single entity. */
export interface ChannelResult {
  /** Which observability channel. */
  channel: OnboardingChannel;
  /** Outcome of the channel check. */
  status: ChannelStatus;
  /** Optional human-readable detail or proposal for remediation. */
  detail?: string;
}

/**
 * Onboarding report for one entity.
 * Produced by `ObservabilityOnboarder.onboard()`.
 */
export interface OnboardingReport {
  /** Entity that was onboarded. */
  entityId: string;
  /** Human-readable name of the entity. */
  entityName: string;
  /** Per-channel results. */
  channels: ChannelResult[];
  /**
   * Observations emitted for gaps in this run.
   * Callers may persist these via ObservationStore / dedup pipeline.
   */
  observations: Observation[];
  /** ISO-8601 timestamp when the report was generated. */
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// ObservabilityOnboarder
// ---------------------------------------------------------------------------

/** Logger interface (narrow). */
export interface OnboarderLogger {
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: OnboarderLogger = {};

/** Options for `ObservabilityOnboarder`. */
export interface ObservabilityOnboarderOptions {
  /**
   * Graph store for Prometheus endpoint discovery.
   * When absent, `prometheusEndpointUrl` must be supplied.
   */
  graphStore?: GraphStore;
  /**
   * Injected HTTP source for Prometheus API queries.
   * Production code passes `FetchPrometheusHttpSource`; tests pass a stub.
   */
  prometheusHttp: PrometheusHttpSource;
  /**
   * Explicit Prometheus base URL override (no trailing slash).
   * When supplied, graph discovery is skipped for Prometheus.
   */
  prometheusEndpointUrl?: string;
  /**
   * Pre-built LogsService (issue #38). Tests inject a stub-backed instance.
   * When absent, logs checks are skipped (`unknown`).
   */
  logsService?: LogsService;
  /**
   * Pre-built GrafanaRegistry (issue #39). Tests inject a stub-backed instance.
   * When absent, dashboard checks are skipped (`unknown`).
   */
  grafanaRegistry?: GrafanaRegistry;
  /**
   * Platform identifier for emitted observations (used in dedup keys).
   * Defaults to `"observability"`.
   */
  platformId?: string;
  /**
   * Optional clock override for deterministic test timestamps.
   * Returns ISO-8601 string. Defaults to `new Date().toISOString()`.
   */
  clock?: () => string;
  /** Optional logger for WARN/DEBUG events. */
  logger?: OnboarderLogger;
}

/**
 * Inspects a service entity and ensures it is wired into the three
 * observability channels (metrics, logs, dashboards). For each missing
 * channel, an `observability_gap` observation is emitted. All three checks
 * are independent and non-fatal to each other.
 *
 * Invariant #62 compliance:
 *   - No hard-coded service names; every decision is attribute-driven.
 *   - A newly-added service is onboarded on the next run with no code change.
 *   - READ-ONLY: never mutates external systems (Prometheus/Loki/Grafana).
 *   - Graceful: unreachable backends → `unknown` (not `gap`).
 */
export class ObservabilityOnboarder {
  private readonly graphStore: GraphStore | undefined;
  private readonly prometheusHttp: PrometheusHttpSource;
  private readonly prometheusEndpointUrl: string | undefined;
  private readonly logsService: LogsService | undefined;
  private readonly grafanaRegistry: GrafanaRegistry | undefined;
  private readonly platformId: string;
  private readonly clock: () => string;
  private readonly logger: OnboarderLogger;

  /** Cached Prometheus base URL (resolved once per instance). */
  private resolvedPrometheusBase: string | null | undefined = undefined;

  constructor(opts: ObservabilityOnboarderOptions) {
    this.graphStore = opts.graphStore;
    this.prometheusHttp = opts.prometheusHttp;
    this.prometheusEndpointUrl = opts.prometheusEndpointUrl;
    this.logsService = opts.logsService;
    this.grafanaRegistry = opts.grafanaRegistry;
    this.platformId = opts.platformId ?? 'observability';
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Onboard a single service entity: check all three channels independently
   * and return a report with per-channel results + emitted observations.
   *
   * Execution is independent per channel: any thrown exception inside a
   * channel check is caught, logged as WARN, and recorded as `check-failed`
   * — it never aborts the other channels or the deploy.
   *
   * Invariant #62: decisions are role/attribute-driven; no hardcoded names.
   *
   * @param entity - Service entity from the inventory graph.
   * @returns Per-channel report + observations for any gaps found.
   */
  async onboard(entity: Entity): Promise<OnboardingReport> {
    const checkedAt = this.clock();
    const channels: ChannelResult[] = [];
    const observations: Observation[] = [];

    // Run all three channels independently (each catches its own errors).
    const [metricsResult, logsResult, dashResult] = await Promise.all([
      this.checkMetricsChannel(entity),
      this.checkLogsChannel(entity),
      this.checkDashboardsChannel(entity),
    ]);

    channels.push(metricsResult, logsResult, dashResult);

    // Emit one observation per gap.
    for (const ch of channels) {
      if (ch.status === 'gap') {
        observations.push(
          this.buildGapObservation(entity, ch.channel, ch.detail, checkedAt),
        );
      }
    }

    return {
      entityId: entity.id,
      entityName: entity.name,
      channels,
      observations,
      checkedAt,
    };
  }

  /**
   * Onboard all `kind="service"` entities in the graph store.
   *
   * Entities that are themselves observability/monitoring infrastructure
   * (role = monitoring|observability|logging) are skipped — they are the
   * observability stack, not consumers of it.
   *
   * @returns Array of per-entity onboarding reports.
   */
  async onboardAll(): Promise<OnboardingReport[]> {
    if (this.graphStore === undefined) return [];

    let services: Entity[];
    try {
      services = await this.graphStore.entitiesByKind('service');
    } catch (err) {
      this.logger.warn?.('onboarder_graph_error', { error: (err as Error).message });
      return [];
    }

    const INFRA_ROLES = new Set(['monitoring', 'observability', 'logging']);

    const reports: OnboardingReport[] = [];
    for (const entity of services) {
      // Skip observability-stack infrastructure entities.
      const role = entity.attributes['role'];
      if (typeof role === 'string' && INFRA_ROLES.has(role)) continue;

      try {
        const report = await this.onboard(entity);
        reports.push(report);
      } catch (err) {
        this.logger.warn?.('onboarder_entity_error', {
          entityId: entity.id,
          error: (err as Error).message,
        });
      }
    }

    return reports;
  }

  // -------------------------------------------------------------------------
  // Private channel checks
  // -------------------------------------------------------------------------

  /**
   * Check whether the entity is scraped by Prometheus.
   *
   * @param entity - Service entity.
   * @returns Channel result (wired | gap | unknown | check-failed).
   */
  private async checkMetricsChannel(entity: Entity): Promise<ChannelResult> {
    let promBase: string | null;
    try {
      promBase = await this.resolvePrometheusBase();
    } catch (err) {
      this.logger.warn?.('onboarder_prometheus_discovery_error', {
        entityId: entity.id,
        error: (err as Error).message,
      });
      return { channel: 'metrics', status: 'check-failed', detail: (err as Error).message };
    }

    if (promBase === null) {
      // Prometheus not discoverable — cannot check.
      return { channel: 'metrics', status: 'unknown', detail: 'Prometheus endpoint not discoverable from graph' };
    }

    let scraped: boolean | null;
    try {
      scraped = await checkMetricsScraping(entity, promBase, this.prometheusHttp);
    } catch (err) {
      this.logger.warn?.('onboarder_prometheus_check_error', {
        entityId: entity.id,
        error: (err as Error).message,
      });
      return { channel: 'metrics', status: 'check-failed', detail: (err as Error).message };
    }

    if (scraped === null) {
      // Prometheus reachable but targets endpoint returned unexpected data.
      return { channel: 'metrics', status: 'unknown', detail: 'Prometheus targets endpoint returned unexpected data' };
    }

    if (scraped) {
      return { channel: 'metrics', status: 'wired' };
    }

    // Gap: entity not found in Prometheus targets.
    const proposal = buildMetricsProposal(entity);
    return {
      channel: 'metrics',
      status: 'gap',
      detail: proposal !== undefined
        ? `Entity '${entity.name}' not found in Prometheus targets. ${proposal}`
        : `Entity '${entity.name}' not found in Prometheus targets.`,
    };
  }

  /**
   * Check whether logs are queryable for the entity via the logs adapter.
   *
   * @param entity - Service entity.
   * @returns Channel result (wired | gap | unknown | check-failed).
   */
  private async checkLogsChannel(entity: Entity): Promise<ChannelResult> {
    if (this.logsService === undefined) {
      return { channel: 'logs', status: 'unknown', detail: 'LogsService not configured' };
    }

    try {
      const result = await this.logsService.query({
        service: entity.name,
        since: '1h',
        limit: 1,
      });

      // If all backends have no endpoint, we cannot check.
      const allNoEndpoint = Object.values(result.backends).every((s) => s === 'no_endpoint');
      if (allNoEndpoint) {
        return { channel: 'logs', status: 'unknown', detail: 'No log backends discovered' };
      }

      if (result.entries.length > 0) {
        return { channel: 'logs', status: 'wired' };
      }

      return {
        channel: 'logs',
        status: 'gap',
        detail: `No log entries found for service '${entity.name}' in the last hour. Ensure log labels include the service name.`,
      };
    } catch (err) {
      this.logger.warn?.('onboarder_logs_check_error', {
        entityId: entity.id,
        error: (err as Error).message,
      });
      return { channel: 'logs', status: 'check-failed', detail: (err as Error).message };
    }
  }

  /**
   * Check whether a Grafana dashboard exists for the entity.
   *
   * @param entity - Service entity.
   * @returns Channel result (wired | gap | unknown | check-failed).
   */
  private async checkDashboardsChannel(entity: Entity): Promise<ChannelResult> {
    if (this.grafanaRegistry === undefined) {
      return { channel: 'dashboards', status: 'unknown', detail: 'GrafanaRegistry not configured' };
    }

    try {
      // Check Grafana endpoint reachability first.
      const base = await this.grafanaRegistry.resolveEndpoint();
      if (base === null) {
        return { channel: 'dashboards', status: 'unknown', detail: 'Grafana endpoint not discoverable from graph' };
      }

      const links = await this.grafanaRegistry.resolveDashboardsForEntity(entity);

      if (links.length > 0) {
        return { channel: 'dashboards', status: 'wired' };
      }

      // Build a generic proposal for creating a role-based dashboard.
      const role = typeof entity.attributes['role'] === 'string'
        ? (entity.attributes['role'] as string)
        : 'generic';
      const proposal =
        `Create a Grafana dashboard for role '${role}' services with ` +
        `var-service template variable and tag it '${entity.name}' or '${role}' ` +
        `so the resolver can match it automatically.`;

      return {
        channel: 'dashboards',
        status: 'gap',
        detail: `No Grafana dashboard matched entity '${entity.name}'. ${proposal}`,
      };
    } catch (err) {
      this.logger.warn?.('onboarder_dashboard_check_error', {
        entityId: entity.id,
        error: (err as Error).message,
      });
      return { channel: 'dashboards', status: 'check-failed', detail: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the Prometheus base URL: explicit config wins over graph
   * discovery. Caches the result per onboarder instance.
   *
   * @returns Base URL or `null` when not discoverable.
   */
  private async resolvePrometheusBase(): Promise<string | null> {
    if (this.resolvedPrometheusBase !== undefined) {
      return this.resolvedPrometheusBase;
    }

    if (typeof this.prometheusEndpointUrl === 'string' && this.prometheusEndpointUrl !== '') {
      this.resolvedPrometheusBase = this.prometheusEndpointUrl.replace(/\/$/, '');
      return this.resolvedPrometheusBase;
    }

    if (this.graphStore !== undefined) {
      this.resolvedPrometheusBase = await discoverPrometheusEndpoint(this.graphStore);
      return this.resolvedPrometheusBase;
    }

    this.resolvedPrometheusBase = null;
    return null;
  }

  /**
   * Build an `observability_gap` observation for a missing channel.
   *
   * The `resource` field is `entity/<entityId>` so dedup works per-entity
   * per-channel. The `dedup_key` is `<platformId>:observability_gap:entity/<entityId>/<channel>`.
   *
   * @param entity    - Service entity.
   * @param channel   - The missing channel.
   * @param detail    - Optional human-readable detail / proposal.
   * @param checkedAt - ISO-8601 timestamp (from clock).
   */
  private buildGapObservation(
    entity: Entity,
    channel: OnboardingChannel,
    detail: string | undefined,
    checkedAt: string,
  ): Observation {
    const resource = `entity/${entity.id}/${channel}`;
    const dedupKey = `${this.platformId}:observability_gap:${resource}`;
    const details: Record<string, unknown> = {
      entityId: entity.id,
      entityName: entity.name,
      channel,
    };
    if (detail !== undefined) {
      details['proposal'] = detail;
    }
    const role = entity.attributes['role'];
    if (typeof role === 'string' && role !== '') {
      details['role'] = role;
    }

    return {
      id: randomUUID(),
      platform: this.platformId,
      pattern: 'observability_gap',
      resource,
      severity: 'P2',
      discovered_at: checkedAt,
      details,
      dedup_key: dedupKey,
    };
  }
}
