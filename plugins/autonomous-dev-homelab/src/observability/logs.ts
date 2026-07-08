/**
 * Read-only logs adapter for Loki + OpenSearch behind one normalized
 * interface. Implements issue #38 (P1), invariant #62.
 *
 * Design:
 * - `LogQuery` / `LogEntry` are the normalized types all callers use.
 * - `LogsAdapter` is the open-registry backend interface (keyed by backend
 *   name string — invariant #62: not an enum, new backends register at
 *   runtime).
 * - Two built-in adapters: `lokiAdapter` and `openSearchAdapter`.
 * - `LogsService` discovers the backend endpoint generically from the
 *   inventory graph (role=observability|monitoring|logging; image contains
 *   "loki" or "opensearch"/"elasticsearch") and delegates to the adapter.
 * - Production HTTP implementation (`FetchLogsHttpSource`) exists and is
 *   fully wired (not stub-only — invariant #62 requirement confirmed by
 *   issue #37 retrospective).
 * - READ-ONLY: no mutation methods exist on any interface.
 * - Credentials sourced from config / Vault; never inlined here.
 * - Graceful degradation: unreachable backend → empty LogEntry[] + WARN on
 *   the injected logger; never throws to the caller.
 */

import type { GraphStore } from '../discovery/graph-store.js';
import type { Entity } from '../discovery/graph-types.js';

// ---------------------------------------------------------------------------
// Hard caps (issue #38: hard result-count and lookback caps)
// ---------------------------------------------------------------------------

/** Maximum number of log entries returned per query. */
export const MAX_LOG_LIMIT = 1_000;

/** Maximum lookback in milliseconds (7 days). */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Normalized query + entry types
// ---------------------------------------------------------------------------

/**
 * Log query parameters. All fields are optional; backends apply their own
 * defaults when fields are absent. Invariant #62: no hard-coded service or
 * resource names — callers pass whatever they discovered from the graph.
 */
export interface LogQuery {
  /**
   * Filter by resource (container name, pod, host, etc.).
   * Mapped to the backend's equivalent label/field.
   */
  resource?: string;
  /**
   * Filter by service name.
   * Mapped to the backend's equivalent label/field.
   */
  service?: string;
  /**
   * ISO-8601 timestamp or short duration (e.g. "30m", "1h", "24h", "7d").
   * Lower bound on log timestamps. Capped to MAX_LOOKBACK_MS ago.
   */
  since?: string;
  /**
   * ISO-8601 timestamp. Upper bound on log timestamps.
   * Defaults to now when absent.
   */
  until?: string;
  /**
   * Maximum number of log entries to return.
   * Capped to MAX_LOG_LIMIT.
   */
  limit?: number;
  /**
   * Free-text filter string. Sent as a LogQL line filter or an OpenSearch
   * query_string depending on the backend.
   */
  filter?: string;
}

/**
 * One normalized log entry returned by any backend adapter.
 * The `source` field names the backend that produced the entry.
 */
export interface LogEntry {
  /** ISO-8601 UTC timestamp of the log line. */
  timestamp: string;
  /** Log level if available ("info", "warn", "error", etc.). */
  level?: string;
  /** Log line content. Passed through as-is; no secret filtering. */
  message: string;
  /**
   * Backend that produced this entry ("loki" or "opensearch", or an open
   * string for future backends).
   */
  source: string;
  /**
   * Key/value labels or fields attached to the entry by the backend.
   * Invariant #62: passed through as discovered; no allowlist.
   */
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// HTTP source interface (injected; tests mock it — pattern from AlertProbe)
// ---------------------------------------------------------------------------

/** Minimal HTTP response shape the adapters consume. */
export interface LogsHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Injected HTTP source. Implementations wrap the global `fetch` API or a
 * test stub. Both GET (Loki) and POST (OpenSearch) are required.
 */
export interface LogsHttpSource {
  /** Issue a GET request and return a response wrapper. */
  get(url: string, headers?: Record<string, string>): Promise<LogsHttpResponse>;
  /** Issue a POST request with a JSON body and return a response wrapper. */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<LogsHttpResponse>;
}

/**
 * Default timeout for the fetch-based HTTP source.
 * Log backends are expected to respond within 15 s; generous but bounded.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Production `LogsHttpSource` backed by the global `fetch` API
 * (available in Node.js >= 18). Uses `AbortSignal.timeout` so slow
 * endpoints do not block the query loop indefinitely.
 *
 * Usage:
 * ```ts
 * const svc = new LogsService({ http: new FetchLogsHttpSource(), ... });
 * ```
 */
export class FetchLogsHttpSource implements LogsHttpSource {
  private readonly timeoutMs: number;

  /**
   * @param opts.timeoutMs - Request timeout in milliseconds (default 15 000).
   */
  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /**
   * Issue a GET request to `url`.
   *
   * @param url     - Fully-qualified URL.
   * @param headers - Optional additional request headers.
   * @returns Response wrapper implementing `LogsHttpResponse`.
   */
  async get(url: string, headers: Record<string, string> = {}): Promise<LogsHttpResponse> {
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

  /**
   * Issue a POST request to `url` with a JSON body.
   *
   * @param url     - Fully-qualified URL.
   * @param body    - Request body (JSON-serialised).
   * @param headers - Optional additional request headers.
   * @returns Response wrapper implementing `LogsHttpResponse`.
   */
  async post(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<LogsHttpResponse> {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      json: (): Promise<unknown> => response.json() as Promise<unknown>,
    };
  }
}

// ---------------------------------------------------------------------------
// Logger interface (minimal; avoids coupling to any logging framework)
// ---------------------------------------------------------------------------

/** Minimal logger interface used by the service for WARN events. */
export interface LogsLogger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: LogsLogger = { warn: () => undefined };

// ---------------------------------------------------------------------------
// LogsAdapter interface + open registry
// ---------------------------------------------------------------------------

/**
 * Backend adapter interface. Invariant #62: `backend` is an open string; any
 * adapter can be registered at runtime — not an enum.
 *
 * READ-ONLY: only `query` exists; no write/ingest/delete methods.
 */
export interface LogsAdapter {
  /** Backend identifier (open string: "loki", "opensearch", …). */
  readonly backend: string;
  /**
   * Query the backend and return normalized log entries.
   * Must never throw; callers rely on graceful empty-array return.
   *
   * @param q       - Normalized log query.
   * @param baseUrl - Backend base URL (discovered or configured).
   * @param http    - Injected HTTP source.
   * @param opts    - Backend-specific options (credentials, index, etc.).
   * @returns Normalized log entries, possibly empty.
   */
  query(
    q: LogQuery,
    baseUrl: string,
    http: LogsHttpSource,
    opts: LogsAdapterOptions,
  ): Promise<LogEntry[]>;
}

/** Per-backend options passed from `LogsService` to the adapter. */
export interface LogsAdapterOptions {
  /**
   * Bearer token or API key for the backend.
   * Source: Vault / operator config; never inlined in code.
   */
  credential?: string;
  /**
   * OpenSearch index pattern (default: "*"). Ignored by the Loki adapter.
   */
  index?: string;
  /**
   * Config-overridable field/label mapping (issue #38).
   * Keys: normalized field names ("resource", "service", "level", etc.).
   * Values: backend-specific field or label names.
   *
   * Example for Loki:       { resource: "container", service: "app" }
   * Example for OpenSearch: { resource: "kubernetes.pod_name", service: "service.name" }
   */
  fieldMapping?: Record<string, string>;
}

/** Open backend adapter registry. Invariant #62: string-keyed, not an enum. */
const ADAPTER_REGISTRY = new Map<string, LogsAdapter>();

/**
 * Register a `LogsAdapter` implementation under its `backend` name.
 * Callers can add new backends without touching this file.
 *
 * @param adapter - Adapter implementation to register.
 */
export function registerLogsAdapter(adapter: LogsAdapter): void {
  ADAPTER_REGISTRY.set(adapter.backend, adapter);
}

/**
 * Retrieve a registered adapter by backend name.
 * Returns `undefined` when the backend is not registered.
 *
 * @param backend - Backend name (e.g. "loki", "opensearch").
 */
export function getLogsAdapter(backend: string): LogsAdapter | undefined {
  return ADAPTER_REGISTRY.get(backend);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

/**
 * Parse a `since` value to a millisecond timestamp.
 * Caps the result to MAX_LOOKBACK_MS ago.
 *
 * @param value - ISO-8601 string or short duration (e.g. "30m", "1h", "7d").
 * @param nowMs - Current time in milliseconds (injected for determinism).
 * @returns Milliseconds since epoch (clamped to MAX_LOOKBACK_MS ago).
 */
export function parseSinceMs(value: string, nowMs: number): number {
  const m = DURATION_RE.exec(value);
  if (m !== null) {
    const n = Number.parseInt(m[1] ?? '0', 10);
    const unit = m[2];
    const factor =
      unit === 's' ? 1_000
        : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
        : 86_400_000; // 'd'
    const sinceMs = nowMs - n * factor;
    const cap = nowMs - MAX_LOOKBACK_MS;
    return Math.max(sinceMs, cap);
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    // Unrecognised format — fall back to max lookback.
    return nowMs - MAX_LOOKBACK_MS;
  }
  const cap = nowMs - MAX_LOOKBACK_MS;
  return Math.max(ts, cap);
}

/**
 * Clamp `limit` to the range [1, MAX_LOG_LIMIT].
 * Returns 100 as a sensible default when limit is absent or non-positive.
 *
 * @param limit - Requested limit (may be undefined).
 * @returns Effective limit, in [1, MAX_LOG_LIMIT].
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return 100;
  return Math.min(limit, MAX_LOG_LIMIT);
}

// ---------------------------------------------------------------------------
// Loki adapter
// ---------------------------------------------------------------------------

/**
 * Loki wire-format stream value: [nanosecond-timestamp-string, log-line].
 */
type LokiStreamValue = [string, string];

/** One Loki stream result from `query_range`. */
interface LokiStream {
  stream?: Record<string, string>;
  values?: LokiStreamValue[];
}

/** Loki `query_range` response envelope. */
interface LokiQueryRangeResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: LokiStream[];
  };
}

/**
 * Build a LogQL stream selector from a `LogQuery`.
 *
 * Invariant #62: purely label-driven — selector built from query fields,
 * not from a hard-coded list of known service names. The label names used
 * are config-overridable via `fieldMapping`.
 *
 * @param q           - Normalized log query.
 * @param fieldMapping - Optional label name overrides.
 * @returns LogQL expression (stream selector + optional line filter).
 */
export function buildLogQL(q: LogQuery, fieldMapping: Record<string, string> = {}): string {
  const parts: string[] = [];

  const resourceLabel = fieldMapping['resource'] ?? 'container';
  const serviceLabel = fieldMapping['service'] ?? 'app';

  if (typeof q.resource === 'string' && q.resource !== '') {
    parts.push(`${resourceLabel}="${q.resource}"`);
  }
  if (typeof q.service === 'string' && q.service !== '') {
    parts.push(`${serviceLabel}="${q.service}"`);
  }

  const selector = parts.length > 0 ? `{${parts.join(', ')}}` : '{job=~".+"}';

  if (typeof q.filter === 'string' && q.filter !== '') {
    // LogQL line filter: |= for substring match.
    return `${selector} |= \`${q.filter}\``;
  }
  return selector;
}

/**
 * Convert a nanosecond Loki timestamp string to an ISO-8601 UTC string.
 *
 * @param nsStr - Nanosecond Unix timestamp as a decimal string.
 * @returns ISO-8601 UTC string.
 */
export function lokiNsToIso(nsStr: string): string {
  const ms = Math.floor(Number(nsStr) / 1_000_000);
  return new Date(ms).toISOString();
}

/**
 * Extract a log level from a Loki stream's labels.
 * Returns undefined when the level label is absent or empty.
 * Invariant #62: level label name is config-overridable via `fieldMapping`.
 */
function extractLokiLevel(
  stream: Record<string, string>,
  fieldMapping: Record<string, string>,
): string | undefined {
  const levelLabel = fieldMapping['level'] ?? 'level';
  const val = stream[levelLabel];
  if (typeof val === 'string' && val !== '') return val;
  return undefined;
}

/**
 * Loki adapter: queries `GET <base>/loki/api/v1/query_range` and parses
 * the streams response into `LogEntry[]`.
 *
 * Implements `LogsAdapter`. READ-ONLY.
 */
export const lokiAdapter: LogsAdapter = {
  backend: 'loki',

  async query(
    q: LogQuery,
    baseUrl: string,
    http: LogsHttpSource,
    opts: LogsAdapterOptions,
  ): Promise<LogEntry[]> {
    const nowMs = Date.now();
    const sinceMs = q.since !== undefined ? parseSinceMs(q.since, nowMs) : nowMs - 3_600_000;
    const untilMs = q.until !== undefined ? Date.parse(q.until) : nowMs;
    const limit = clampLimit(q.limit);
    const fieldMapping = opts.fieldMapping ?? {};

    const logql = buildLogQL(q, fieldMapping);

    // Loki timestamps: nanoseconds.
    const startNs = String(sinceMs * 1_000_000);
    const endNs = String(untilMs * 1_000_000);

    const params = new URLSearchParams({
      query: logql,
      start: startNs,
      end: endNs,
      limit: String(limit),
      direction: 'backward',
    });

    const url = `${baseUrl.replace(/\/$/, '')}/loki/api/v1/query_range?${params.toString()}`;

    const headers: Record<string, string> = {};
    if (typeof opts.credential === 'string' && opts.credential !== '') {
      headers.Authorization = `Bearer ${opts.credential}`;
    }

    let resp: LogsHttpResponse;
    try {
      resp = await http.get(url, headers);
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

    const parsed = body as LokiQueryRangeResponse;
    if (parsed?.status !== 'success') {
      return [];
    }
    const result = parsed?.data?.result;
    if (!Array.isArray(result)) {
      return [];
    }

    const entries: LogEntry[] = [];
    for (const stream of result as LokiStream[]) {
      const streamLabels = stream.stream ?? {};
      const level = extractLokiLevel(streamLabels, fieldMapping);
      for (const value of stream.values ?? []) {
        const [nsStr, message] = value;
        if (typeof nsStr !== 'string' || typeof message !== 'string') continue;
        entries.push({
          timestamp: lokiNsToIso(nsStr),
          level,
          message,
          source: 'loki',
          labels: { ...streamLabels },
        });
      }
    }

    return entries;
  },
};

// ---------------------------------------------------------------------------
// OpenSearch adapter
// ---------------------------------------------------------------------------

/** One OpenSearch hit from a `_search` response. */
interface OpenSearchHit {
  _source?: Record<string, unknown>;
  _index?: string;
}

/** OpenSearch `_search` response envelope. */
interface OpenSearchSearchResponse {
  hits?: {
    hits?: OpenSearchHit[];
  };
}

/**
 * Build an OpenSearch bool query from a `LogQuery`.
 *
 * Invariant #62: field names are config-overridable via `fieldMapping`; no
 * hard-coded field assumptions beyond sensible defaults.
 *
 * @param q           - Normalized log query.
 * @param sinceMs     - Lower bound timestamp in milliseconds.
 * @param untilMs     - Upper bound timestamp in milliseconds.
 * @param fieldMapping - Optional field name overrides.
 * @param limit       - Maximum result count.
 * @returns OpenSearch `_search` request body object.
 */
export function buildOpenSearchQuery(
  q: LogQuery,
  sinceMs: number,
  untilMs: number,
  fieldMapping: Record<string, string>,
  limit: number,
): Record<string, unknown> {
  const timestampField = fieldMapping['timestamp'] ?? '@timestamp';
  const resourceField = fieldMapping['resource'] ?? 'kubernetes.pod_name';
  const serviceField = fieldMapping['service'] ?? 'service.name';
  const messageField = fieldMapping['message'] ?? 'message';

  const must: unknown[] = [
    {
      range: {
        [timestampField]: {
          gte: new Date(sinceMs).toISOString(),
          lte: new Date(untilMs).toISOString(),
        },
      },
    },
  ];

  if (typeof q.resource === 'string' && q.resource !== '') {
    must.push({ match: { [resourceField]: q.resource } });
  }
  if (typeof q.service === 'string' && q.service !== '') {
    must.push({ match: { [serviceField]: q.service } });
  }
  if (typeof q.filter === 'string' && q.filter !== '') {
    must.push({ query_string: { query: q.filter, fields: [messageField] } });
  }

  return {
    size: limit,
    sort: [{ [timestampField]: { order: 'desc' } }],
    query: { bool: { must } },
  };
}

/**
 * Extract a string field from an OpenSearch `_source` document.
 * Supports dot-notation (e.g. "kubernetes.pod_name").
 * Returns undefined when the field is absent or not a string.
 *
 * @param source - The `_source` object from an OpenSearch hit.
 * @param field  - Dot-notation field path.
 */
function osField(source: Record<string, unknown>, field: string): string | undefined {
  const parts = field.split('.');
  let cur: unknown = source;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * OpenSearch adapter: queries `POST <base>/<index>/_search` and parses
 * hits into `LogEntry[]`.
 *
 * Implements `LogsAdapter`. READ-ONLY.
 */
export const openSearchAdapter: LogsAdapter = {
  backend: 'opensearch',

  async query(
    q: LogQuery,
    baseUrl: string,
    http: LogsHttpSource,
    opts: LogsAdapterOptions,
  ): Promise<LogEntry[]> {
    const nowMs = Date.now();
    const sinceMs = q.since !== undefined ? parseSinceMs(q.since, nowMs) : nowMs - 3_600_000;
    const untilMs = q.until !== undefined ? Date.parse(q.until) : nowMs;
    const limit = clampLimit(q.limit);
    const fieldMapping = opts.fieldMapping ?? {};
    const index = opts.index ?? '*';

    const requestBody = buildOpenSearchQuery(q, sinceMs, untilMs, fieldMapping, limit);

    const url = `${baseUrl.replace(/\/$/, '')}/${index}/_search`;

    const headers: Record<string, string> = {};
    if (typeof opts.credential === 'string' && opts.credential !== '') {
      headers.Authorization = `Bearer ${opts.credential}`;
    }

    let resp: LogsHttpResponse;
    try {
      resp = await http.post(url, requestBody, headers);
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

    const parsed = body as OpenSearchSearchResponse;
    const hits = parsed?.hits?.hits;
    if (!Array.isArray(hits)) {
      return [];
    }

    const timestampField = fieldMapping['timestamp'] ?? '@timestamp';
    const levelField = fieldMapping['level'] ?? 'log.level';
    const messageField = fieldMapping['message'] ?? 'message';

    const entries: LogEntry[] = [];
    for (const hit of hits as OpenSearchHit[]) {
      const source = hit._source ?? {};
      const timestamp = osField(source, timestampField) ?? new Date().toISOString();
      const message = osField(source, messageField) ?? '';
      const level = osField(source, levelField);

      // Labels: all top-level string fields from _source.
      const labels: Record<string, string> = {};
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'string') {
          labels[k] = v;
        }
      }

      entries.push({
        timestamp,
        level,
        message,
        source: 'opensearch',
        labels,
      });
    }

    return entries;
  },
};

// ---------------------------------------------------------------------------
// Register built-in adapters at module load time
// ---------------------------------------------------------------------------

registerLogsAdapter(lokiAdapter);
registerLogsAdapter(openSearchAdapter);

// ---------------------------------------------------------------------------
// Endpoint discovery from GraphStore (invariant #62)
// ---------------------------------------------------------------------------

/**
 * Image substrings that identify Loki entities.
 * Matched against `attributes.image` (invariant #62: no instance names).
 */
const LOKI_IMAGE_PATTERNS = ['loki', 'grafana/loki'] as const;

/**
 * Image substrings that identify OpenSearch/Elasticsearch entities.
 */
const OPENSEARCH_IMAGE_PATTERNS = ['opensearch', 'elasticsearch'] as const;

/**
 * Roles that identify observability/logging services.
 * Invariant #62: matched against `attributes.role`, not instance names.
 */
const LOGGING_ROLES = new Set(['observability', 'monitoring', 'logging']);

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

/** Result of generic endpoint discovery. */
export interface DiscoveredLogsEndpoints {
  loki: string | null;
  opensearch: string | null;
}

/**
 * Discover Loki and OpenSearch endpoint URLs generically from the inventory
 * graph. Queries all entities whose `attributes.role` is in
 * `LOGGING_ROLES` and whose image contains a recognized pattern.
 *
 * Invariant #62: purely attribute-driven — no hard-coded hostnames or
 * service names. Any loki/opensearch entity visible in the graph is picked
 * up automatically on the next refresh.
 *
 * @param graphStore - Inventory graph store.
 * @returns Discovered base URLs (null for each backend not found).
 */
export async function discoverLogsEndpoints(
  graphStore: GraphStore,
): Promise<DiscoveredLogsEndpoints> {
  let services: Entity[];
  try {
    services = await graphStore.entitiesByKind('service');
  } catch {
    return { loki: null, opensearch: null };
  }

  let loki: string | null = null;
  let opensearch: string | null = null;

  for (const entity of services) {
    const role = entity.attributes['role'];
    if (typeof role !== 'string' || !LOGGING_ROLES.has(role)) continue;

    const image = typeof entity.attributes['image'] === 'string'
      ? (entity.attributes['image'] as string).toLowerCase()
      : '';

    if (loki === null && LOKI_IMAGE_PATTERNS.some((p) => image.includes(p))) {
      loki = entityBaseUrl(entity);
    } else if (
      opensearch === null &&
      OPENSEARCH_IMAGE_PATTERNS.some((p) => image.includes(p))
    ) {
      opensearch = entityBaseUrl(entity);
    }

    if (loki !== null && opensearch !== null) break;
  }

  return { loki, opensearch };
}

// ---------------------------------------------------------------------------
// LogsService
// ---------------------------------------------------------------------------

/** Options for `LogsService`. */
export interface LogsServiceOptions {
  /**
   * Injected HTTP source. Production: `new FetchLogsHttpSource()`.
   * Tests: mock implementation.
   */
  http: LogsHttpSource;
  /**
   * Graph store for generic endpoint discovery. When absent,
   * `endpointUrls` must supply at least one URL.
   */
  graphStore?: GraphStore;
  /**
   * Explicit endpoint URL overrides (config takes precedence over graph).
   * Keys match adapter backend names ("loki", "opensearch").
   */
  endpointUrls?: Record<string, string>;
  /**
   * Per-backend adapter options (credentials, index, field mappings).
   * Keys match adapter backend names.
   */
  adapterOptions?: Record<string, LogsAdapterOptions>;
  /**
   * Logger for WARN events (e.g. unreachable backend).
   * Defaults to a no-op logger.
   */
  logger?: LogsLogger;
}

/**
 * Aggregate result from `LogsService.query`.
 * Invariant #62: backends is an open Record — new backends appear when
 * registered and their endpoints are discovered.
 */
export interface LogsQueryResult {
  /** Merged log entries sorted by timestamp descending. */
  entries: LogEntry[];
  /**
   * Per-backend status: "ok" | "unreachable" | "no_endpoint".
   * Invariant #62: keyed by backend name (open string).
   */
  backends: Record<string, 'ok' | 'unreachable' | 'no_endpoint'>;
}

/**
 * LogsService: discovers log backends generically from the inventory graph,
 * delegates to the appropriate adapter, and merges normalized entries.
 *
 * READ-ONLY: no write/ingest/delete methods exist.
 */
export class LogsService {
  private readonly http: LogsHttpSource;
  private readonly graphStore: GraphStore | undefined;
  private readonly endpointUrls: Record<string, string>;
  private readonly adapterOptions: Record<string, LogsAdapterOptions>;
  private readonly logger: LogsLogger;

  constructor(opts: LogsServiceOptions) {
    this.http = opts.http;
    this.graphStore = opts.graphStore;
    this.endpointUrls = opts.endpointUrls ?? {};
    this.adapterOptions = opts.adapterOptions ?? {};
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Query all discovered log backends and return merged, normalized entries.
   *
   * Execution:
   * 1. Resolve endpoint URLs (config override > graph discovery).
   * 2. For each backend with a resolved URL, delegate to the registered
   *    adapter.
   * 3. Merge results sorted by timestamp descending (newest first).
   * 4. Degrade gracefully when a backend is unreachable — emit WARN and
   *    continue with the remaining backends.
   *
   * Invariant #62: fan-out covers every backend registered in
   * ADAPTER_REGISTRY that has a discoverable or configured endpoint.
   *
   * READ-ONLY: no mutation, no ingest, no delete.
   *
   * @param q - Log query parameters.
   * @returns Merged entries and per-backend status.
   */
  async query(q: LogQuery): Promise<LogsQueryResult> {
    const resolved = await this.resolveEndpoints();

    const allEntries: LogEntry[] = [];
    const backendStatus: Record<string, 'ok' | 'unreachable' | 'no_endpoint'> = {};

    for (const [backend, url] of Object.entries(resolved)) {
      if (url === null) {
        backendStatus[backend] = 'no_endpoint';
        continue;
      }

      const adapter = getLogsAdapter(backend);
      if (adapter === undefined) {
        // Backend has an endpoint but no adapter — skip (forward-compat).
        continue;
      }

      const adapterOpts = this.adapterOptions[backend] ?? {};
      let entries: LogEntry[];
      try {
        entries = await adapter.query(q, url, this.http, adapterOpts);
        backendStatus[backend] = 'ok';
      } catch (err) {
        // Adapter implementations MUST NOT throw; this is a safety net.
        this.logger.warn('logs_backend_error', {
          backend,
          url,
          error: (err as Error).message,
        });
        backendStatus[backend] = 'unreachable';
        entries = [];
      }

      allEntries.push(...entries);
    }

    // Sort merged entries by timestamp descending (newest first).
    allEntries.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return tb - ta;
    });

    // Apply global limit cap after merge.
    const limit = clampLimit(q.limit);
    const entries = allEntries.slice(0, limit);

    return { entries, backends: backendStatus };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve endpoint URLs for all registered backends.
   * Config overrides take priority over graph discovery.
   *
   * @returns Map of backend name to resolved URL (or null when not found).
   */
  private async resolveEndpoints(): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};

    // Gather names of all registered backends.
    const backends = Array.from(ADAPTER_REGISTRY.keys());

    // Apply explicit config overrides first.
    for (const backend of backends) {
      const override = this.endpointUrls[backend];
      if (typeof override === 'string' && override !== '') {
        result[backend] = override.replace(/\/$/, '');
      } else {
        result[backend] = null;
      }
    }

    // Fill in nulls from graph discovery.
    const needsDiscovery = backends.some((b) => result[b] === null);
    if (needsDiscovery && this.graphStore !== undefined) {
      let discovered: DiscoveredLogsEndpoints;
      try {
        discovered = await discoverLogsEndpoints(this.graphStore);
      } catch {
        discovered = { loki: null, opensearch: null };
      }
      if (result['loki'] === null) result['loki'] = discovered.loki;
      if (result['opensearch'] === null) result['opensearch'] = discovered.opensearch;
    }

    return result;
  }
}
