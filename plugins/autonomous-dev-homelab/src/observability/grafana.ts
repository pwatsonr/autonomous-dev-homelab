/**
 * Grafana dashboard registry + per-entity deep-link resolver.
 * Implements GitHub issue #39, invariant #62 (dynamic-first).
 *
 * Design:
 *   1. Discover the Grafana endpoint generically from the inventory graph by
 *      querying entities with role="monitoring" or role="observability" whose
 *      image contains "grafana". A config override (`opts.endpointUrl`) is
 *      accepted when the graph is not yet populated.
 *   2. `GrafanaRegistry` fetches the dashboard catalogue from
 *      GET /api/search?type=dash-db using an API token read generically from
 *      the environment (GRAFANA_API_TOKEN) or from a Vault-materialized secret
 *      (opts.apiToken). If absent, the registry degrades to an empty catalogue.
 *   3. `resolveDashboardsForEntity(entity)` matches the entity to dashboards
 *      generically via tag/title/folder signals derived from the entity's
 *      name, role, and service/job labels — first exact, then fuzzy. Returns
 *      deep-links `<grafana>/d/<uid>/<slug>?var-service=<name>&from=now-1h&to=now`.
 *   4. HTTP source is injected (`GrafanaHttpSource`) so tests never make live
 *      calls. `FetchGrafanaHttpSource` is the production implementation.
 *
 * Invariant #62 compliance:
 *   - Endpoint discovered from graph attributes, never a hard-coded URL.
 *   - Token read from env/Vault generically, never hard-coded.
 *   - Dashboard matching uses generic signals (name, role, labels, tags).
 *   - Any entity is resolvable; unknown entities return [].
 *   - Graceful: unreachable Grafana or absent token -> empty result, no throw.
 */

import type { Entity } from '../discovery/graph-types.js';
import type { GraphStore } from '../discovery/graph-store.js';

// ---------------------------------------------------------------------------
// HTTP source interface (injected seam for tests)
// ---------------------------------------------------------------------------

/** Minimal HTTP response shape the registry consumes. */
export interface GrafanaHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Injected HTTP source. Tests supply a stub; production wires
 * `FetchGrafanaHttpSource`.
 */
export interface GrafanaHttpSource {
  /**
   * Issue a GET request to `url` with optional headers.
   *
   * @param url     - Fully-qualified URL.
   * @param headers - Optional request headers (e.g. `{ Authorization: ... }`).
   */
  get(url: string, headers?: Record<string, string>): Promise<GrafanaHttpResponse>;
}

/**
 * Default timeout for the fetch-based HTTP source.
 * Grafana is expected to respond within 10 s on a local network.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Production `GrafanaHttpSource` backed by the global `fetch` API
 * (Node.js >= 18). Uses `AbortSignal.timeout` so a slow endpoint never
 * blocks the caller indefinitely.
 *
 * Usage:
 * ```ts
 * const registry = new GrafanaRegistry({ http: new FetchGrafanaHttpSource() });
 * ```
 */
export class FetchGrafanaHttpSource implements GrafanaHttpSource {
  private readonly timeoutMs: number;

  /**
   * @param opts.timeoutMs - Request timeout in milliseconds (default 10 000).
   */
  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /**
   * Issue a GET request and return a minimal response wrapper.
   * Throws on network-level failure (the caller handles this by returning []).
   *
   * @param url     - The fully-qualified URL to fetch.
   * @param headers - Optional HTTP headers.
   */
  async get(url: string, headers?: Record<string, string>): Promise<GrafanaHttpResponse> {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(headers ?? {}),
      },
    });
    return {
      ok: response.ok,
      status: response.status,
      json: (): Promise<unknown> => response.json() as Promise<unknown>,
    };
  }
}

// ---------------------------------------------------------------------------
// Grafana API wire types
// ---------------------------------------------------------------------------

/**
 * One dashboard entry as returned by Grafana GET /api/search?type=dash-db.
 * Only the fields the registry consumes are typed; the rest pass through.
 */
export interface GrafanaDashboardSearchResult {
  uid: string;
  title: string;
  url: string;
  folderTitle?: string;
  tags?: string[];
  type?: string;
}

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

/**
 * A resolved deep-link from Grafana to a specific dashboard, pre-populated
 * with template variables and a default time range.
 */
export interface DashboardLink {
  /** Dashboard UID in Grafana. */
  uid: string;
  /** Human-readable dashboard title. */
  title: string;
  /** Folder the dashboard belongs to (empty string when at root). */
  folder: string;
  /** Tags on the dashboard. */
  tags: string[];
  /**
   * Deep-link URL. Includes template variable parameters derived from the
   * entity (e.g. `?var-service=sonarr`) and a default time range.
   */
  deepLink: string;
  /**
   * How well the dashboard matched: `"exact"` means the entity name or a
   * label appeared verbatim in a tag, title, or folder; `"fuzzy"` means a
   * normalised substring match.
   */
  matchKind: 'exact' | 'fuzzy';
}

// ---------------------------------------------------------------------------
// Grafana endpoint discovery from the graph (invariant #62)
// ---------------------------------------------------------------------------

/**
 * Observable image-name substrings that identify a Grafana entity.
 * Invariant #62: matched against graph attributes, not hard-coded hostnames.
 */
const GRAFANA_IMAGE_PATTERNS = ['grafana'] as const;

/**
 * Roles that monitoring/observability entities carry in the graph.
 * Both values are checked so the graph schema is not forced to use one string.
 */
const GRAFANA_ROLES = ['monitoring', 'observability'] as const;

/**
 * Extract a base URL from a graph entity's attributes.
 * Tries `attributes.url` first, then constructs from `attributes.host` +
 * `attributes.port`. Returns `null` when neither is available.
 *
 * @param entity - Graph entity to extract the URL from.
 * @returns Base URL string or `null`.
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
 * Discover the Grafana base URL from the inventory graph.
 *
 * Queries all entities with `kind="service"` whose `attributes.role` is
 * "monitoring" or "observability" AND whose `attributes.image` contains
 * "grafana". Returns the first match's base URL, or `null` if none found.
 *
 * Invariant #62: purely attribute-driven -- no hard-coded hostnames or IPs.
 *
 * @param graphStore - The graph store to query.
 * @returns Base URL (no trailing slash) or `null`.
 */
export async function discoverGrafanaEndpoint(graphStore: GraphStore): Promise<string | null> {
  let services: Entity[];
  try {
    services = await graphStore.entitiesByKind('service');
  } catch {
    return null;
  }

  for (const entity of services) {
    const role = entity.attributes['role'];
    const hasRole = GRAFANA_ROLES.some((r) => role === r);
    if (!hasRole) continue;

    const image =
      typeof entity.attributes['image'] === 'string'
        ? (entity.attributes['image'] as string).toLowerCase()
        : '';
    const isGrafana = GRAFANA_IMAGE_PATTERNS.some((p) => image.includes(p));
    if (!isGrafana) continue;

    const url = entityBaseUrl(entity);
    if (url !== null) return url;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token discovery (generic -- env var then opts fallback; never hard-coded)
// ---------------------------------------------------------------------------

/**
 * Resolve the Grafana API token generically.
 *
 * Priority:
 *   1. `opts.apiToken` (explicitly supplied by caller / Vault-materialised).
 *   2. `GRAFANA_API_TOKEN` environment variable.
 *   3. `null` (no token; caller must degrade gracefully).
 *
 * Invariant #62: never hard-coded; always read from external, opaque sources.
 *
 * @param apiToken - Optional explicit token.
 * @param env      - Process environment (or override for tests).
 * @returns The API token string or `null`.
 */
export function resolveGrafanaToken(
  apiToken: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  if (typeof apiToken === 'string' && apiToken !== '') {
    return apiToken;
  }
  const fromEnv = env['GRAFANA_API_TOKEN'];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return fromEnv;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dashboard matching helpers (generic -- no hard-coded service->dashboard map)
// ---------------------------------------------------------------------------

/**
 * Normalise a string for fuzzy matching: lowercase, replace non-alphanumeric
 * runs with a single space, trim.
 *
 * @param s - Input string.
 * @returns Normalised string.
 */
export function normaliseSignal(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Derive a set of match signals for an entity (invariant #62: generic).
 *
 * Signals are drawn from the entity's name, role, and service/job labels.
 * Both raw and normalised forms are included so callers can check either.
 *
 * @param entity - The entity to derive signals from.
 * @returns Array of lowercase signal strings.
 */
export function entitySignals(entity: Entity): string[] {
  const raw: string[] = [];

  // Name is always a signal.
  raw.push(entity.name);

  // Role is a signal when present.
  const role = entity.attributes['role'];
  if (typeof role === 'string' && role !== '') {
    raw.push(role);
  }

  // service and job labels are primary Prometheus/Grafana routing signals.
  for (const labelKey of ['service', 'job', 'app', 'component'] as const) {
    const val = entity.attributes[`label_${labelKey}`] ?? entity.attributes[labelKey];
    if (typeof val === 'string' && val !== '') {
      raw.push(val);
    }
  }

  // Deduplicate; return lowercased.
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
 * Determine whether a dashboard matches an entity signal at the `"exact"` or
 * `"fuzzy"` level, or not at all.
 *
 * - Exact: a signal appears verbatim in a tag, or the normalised signal equals
 *   the normalised title or folder.
 * - Fuzzy: the normalised signal appears as a substring in the normalised
 *   title, folder, or a tag (minimum 3 characters to avoid noise).
 *
 * @param signals - Entity signals (lowercased).
 * @param d       - Raw Grafana dashboard entry.
 * @returns `"exact"`, `"fuzzy"`, or `null` for no match.
 */
export function matchDashboard(
  signals: string[],
  d: GrafanaDashboardSearchResult,
): 'exact' | 'fuzzy' | null {
  const normTitle = normaliseSignal(d.title);
  const normFolder = d.folderTitle !== undefined ? normaliseSignal(d.folderTitle) : '';
  const tags = (d.tags ?? []).map((t) => t.toLowerCase().trim());

  for (const signal of signals) {
    const normSignal = normaliseSignal(signal);

    // Exact: tag equals signal, or title/folder equals signal exactly.
    if (tags.includes(normSignal)) return 'exact';
    if (normTitle === normSignal) return 'exact';
    if (normFolder !== '' && normFolder === normSignal) return 'exact';

    // Fuzzy: signal is a substring of title or folder or any tag.
    if (normSignal.length >= 3) {
      if (normTitle.includes(normSignal)) return 'fuzzy';
      if (normFolder !== '' && normFolder.includes(normSignal)) return 'fuzzy';
      if (tags.some((t) => t.includes(normSignal))) return 'fuzzy';
    }
  }

  return null;
}

/**
 * Build the deep-link URL for a dashboard, populating template variables
 * generically from entity attributes and appending a default time range.
 *
 * Variable construction (invariant #62 -- generic, not a hard-coded map):
 *   - `var-service` set to the entity's `service` label, `job` label, or
 *     name (first non-empty wins).
 *   - `var-job` set to the entity's `job` label when distinct from `service`.
 *   - `var-instance` set to `attributes.host` when present.
 *   - `from=now-1h` and `to=now` as the default time range.
 *
 * @param grafanaBase - Grafana base URL (no trailing slash).
 * @param d           - Raw Grafana dashboard entry.
 * @param entity      - The entity to build variables for.
 * @returns Deep-link URL string.
 */
export function buildDeepLink(
  grafanaBase: string,
  d: GrafanaDashboardSearchResult,
  entity: Entity,
): string {
  // d.url from the Grafana search API is the canonical path (e.g. /d/abc/title).
  const dashPath = d.url.startsWith('/') ? d.url : `/${d.url}`;

  // Build template variable params generically from entity attributes.
  const params = new URLSearchParams();

  // service variable: label_service > service > label_job > job > entity name.
  const serviceLabel =
    (typeof entity.attributes['label_service'] === 'string'
      ? (entity.attributes['label_service'] as string)
      : '') ||
    (typeof entity.attributes['service'] === 'string'
      ? (entity.attributes['service'] as string)
      : '') ||
    entity.name;
  if (serviceLabel !== '') {
    params.set('var-service', serviceLabel);
  }

  // job variable when distinct from service.
  const jobLabel =
    (typeof entity.attributes['label_job'] === 'string'
      ? (entity.attributes['label_job'] as string)
      : '') ||
    (typeof entity.attributes['job'] === 'string'
      ? (entity.attributes['job'] as string)
      : '');
  if (jobLabel !== '' && jobLabel !== serviceLabel) {
    params.set('var-job', jobLabel);
  }

  // instance variable from host attribute.
  const host =
    typeof entity.attributes['host'] === 'string'
      ? (entity.attributes['host'] as string)
      : '';
  if (host !== '') {
    params.set('var-instance', host);
  }

  // Default time range.
  params.set('from', 'now-1h');
  params.set('to', 'now');

  return `${grafanaBase}${dashPath}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// GrafanaRegistry
// ---------------------------------------------------------------------------

/** Options for constructing a `GrafanaRegistry`. */
export interface GrafanaRegistryOptions {
  /**
   * Injected HTTP source. Production code passes `FetchGrafanaHttpSource`;
   * tests pass a stub.
   */
  http: GrafanaHttpSource;
  /**
   * Graph store used to discover the Grafana endpoint.
   * When absent, `endpointUrl` must be supplied.
   */
  graphStore?: GraphStore;
  /**
   * Explicit Grafana base URL override (no trailing slash).
   * When supplied, graph discovery is skipped.
   * Example: `"http://grafana.local:3000"`
   */
  endpointUrl?: string;
  /**
   * Grafana API token. When absent, `GRAFANA_API_TOKEN` env var is read.
   * If neither is present, anonymous requests are attempted; Grafana may
   * return dashboards when anonymous access is enabled, or a 401 which
   * degrades gracefully to an empty catalogue.
   */
  apiToken?: string;
  /**
   * Process environment for reading `GRAFANA_API_TOKEN`.
   * Defaults to `process.env`. Override in tests.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Queries the Grafana HTTP API and maps entities to their relevant dashboards.
 *
 * Invariant #62:
 *   - Endpoint is discovered generically from the graph or an explicit override.
 *   - API token is read from the environment or an explicit override -- never
 *     hard-coded.
 *   - Dashboard catalogue is fetched live; no hard-coded map of services to
 *     dashboards.
 *   - Any entity can be resolved; unknown entities return [].
 *   - Unreachable Grafana or absent token -> empty catalogue, no throw.
 */
export class GrafanaRegistry {
  private readonly http: GrafanaHttpSource;
  private readonly graphStore: GraphStore | undefined;
  private readonly endpointUrl: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly env: NodeJS.ProcessEnv;

  /** Cached dashboard catalogue (populated on first `fetchDashboards` call). */
  private catalogue: GrafanaDashboardSearchResult[] | null = null;
  /** Cached resolved Grafana base URL. */
  private resolvedBase: string | null | undefined = undefined;

  constructor(opts: GrafanaRegistryOptions) {
    this.http = opts.http;
    this.graphStore = opts.graphStore;
    this.endpointUrl = opts.endpointUrl;
    this.apiToken = opts.apiToken;
    this.env = opts.env ?? process.env;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fetch and return all dashboards from the Grafana API.
   *
   * Results are cached after the first successful fetch. On any HTTP or
   * network error, returns `[]` (graceful degradation, issue #39 AC).
   *
   * @returns Array of dashboard search results (may be empty).
   */
  async fetchDashboards(): Promise<GrafanaDashboardSearchResult[]> {
    if (this.catalogue !== null) return this.catalogue;

    const base = await this.resolveEndpoint();
    if (base === null) {
      this.catalogue = [];
      return [];
    }

    const token = resolveGrafanaToken(this.apiToken, this.env);
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = `${base}/api/search?type=dash-db`;
    let resp: GrafanaHttpResponse;
    try {
      resp = await this.http.get(url, headers);
    } catch {
      // Network-level failure -- degrade gracefully.
      this.catalogue = [];
      return [];
    }

    if (!resp.ok) {
      // HTTP error -- degrade gracefully.
      this.catalogue = [];
      return [];
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      this.catalogue = [];
      return [];
    }

    if (!Array.isArray(body)) {
      this.catalogue = [];
      return [];
    }

    // Filter to entries that have at least uid + title + url.
    const dashboards = (body as unknown[])
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>)['uid'] === 'string' &&
          typeof (item as Record<string, unknown>)['title'] === 'string' &&
          typeof (item as Record<string, unknown>)['url'] === 'string',
      )
      .map((item) => ({
        uid: item['uid'] as string,
        title: item['title'] as string,
        url: item['url'] as string,
        folderTitle: item['folderTitle'] as string | undefined,
        tags: Array.isArray(item['tags']) ? (item['tags'] as string[]) : [],
        type: item['type'] as string | undefined,
      }));

    this.catalogue = dashboards;
    return dashboards;
  }

  /**
   * Resolve dashboards for a single entity and return deep-links.
   *
   * Matching is purely generic (invariant #62):
   *   1. Collect signals from the entity (name, role, service/job labels).
   *   2. For each dashboard in the catalogue, determine if any signal is an
   *      exact or fuzzy match against the dashboard's title, folder, or tags.
   *   3. Exact matches sort before fuzzy matches.
   *   4. Build a deep-link URL with template variables populated generically
   *      from the entity's attributes.
   *
   * Returns `[]` on no match, unreachable Grafana, or absent token.
   *
   * @param entity - Any inventory graph entity.
   * @returns Array of `DashboardLink` (may be empty).
   */
  async resolveDashboardsForEntity(entity: Entity): Promise<DashboardLink[]> {
    const base = await this.resolveEndpoint();
    if (base === null) return [];

    const dashboards = await this.fetchDashboards();
    if (dashboards.length === 0) return [];

    const signals = entitySignals(entity);
    if (signals.length === 0) return [];

    const exact: DashboardLink[] = [];
    const fuzzy: DashboardLink[] = [];

    for (const d of dashboards) {
      const kind = matchDashboard(signals, d);
      if (kind === null) continue;

      const link: DashboardLink = {
        uid: d.uid,
        title: d.title,
        folder: d.folderTitle ?? '',
        tags: d.tags ?? [],
        deepLink: buildDeepLink(base, d, entity),
        matchKind: kind,
      };

      if (kind === 'exact') {
        exact.push(link);
      } else {
        fuzzy.push(link);
      }
    }

    return [...exact, ...fuzzy];
  }

  /**
   * Resolve the Grafana base URL: explicit config wins over graph discovery.
   * Returns `null` when neither is available. Caches the result.
   *
   * @returns Base URL or `null`.
   */
  async resolveEndpoint(): Promise<string | null> {
    if (this.resolvedBase !== undefined) return this.resolvedBase;

    if (typeof this.endpointUrl === 'string' && this.endpointUrl !== '') {
      this.resolvedBase = this.endpointUrl.replace(/\/$/, '');
      return this.resolvedBase;
    }

    if (this.graphStore !== undefined) {
      this.resolvedBase = await discoverGrafanaEndpoint(this.graphStore);
      return this.resolvedBase;
    }

    this.resolvedBase = null;
    return null;
  }

  /**
   * Invalidate the in-memory cache so the next call to `fetchDashboards`
   * re-queries Grafana. Useful after a long-lived registry detects staleness.
   */
  invalidate(): void {
    this.catalogue = null;
    this.resolvedBase = undefined;
  }
}
