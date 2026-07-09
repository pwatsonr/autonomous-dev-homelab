/**
 * NPM (Nginx Proxy Manager) reverse-proxy route adapter (issue #29).
 *
 * Generically discovers the reverse-proxy entity from the graph (by
 * `attributes.role === 'reverse-proxy'`), queries its API for proxy-host
 * records, and emits:
 *   - `kind='route'` entities (domain, forward_host:port, ssl)
 *   - `routes-to` edges from route → matched target service entity
 *
 * Dynamic-first invariant (#62):
 * - The proxy entity is found generically by role — no hard-coded service
 *   name or IP. Any reverse-proxy classified service works.
 * - Target matching is generic: route.forward_host + forward_port compared
 *   against all service entities' `attributes.host` / exposed ports. If no
 *   match is found the route entity is still created (just no routes-to edge).
 * - API token is read from the environment (NPM_API_TOKEN) or a Vault-backed
 *   credential; never hard-coded.
 * - Graceful degradation: if the reverse-proxy entity is absent or the API
 *   is unreachable, returns an empty result without throwing.
 *
 * NPM API reference: https://nginxproxymanager.com/api/
 */

import type { Entity, Edge } from '../graph-types.js';
import type { GraphStore } from '../graph-store.js';

// ---------------------------------------------------------------------------
// HTTP fetch interface (injectable for tests)
// ---------------------------------------------------------------------------

/** Minimal shape of a fetch-like function (matches global `fetch`). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// NPM API response shape
// ---------------------------------------------------------------------------

/**
 * A single proxy-host record as returned by the NPM API
 * `GET /api/nginx/proxy-hosts`.
 *
 * Only the fields we consume are typed; the API returns more.
 */
export interface NpmProxyHost {
  id: number;
  domain_names: string[];
  forward_host: string;
  forward_port: number;
  forward_scheme: string;
  ssl_forced: boolean;
  certificate_id?: number | string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Adapter result
// ---------------------------------------------------------------------------

export interface NpmAdapterResult {
  /** `route` entities discovered from proxy-host records. */
  entities: Entity[];
  /** `routes-to` edges from route → target service. */
  edges: Edge[];
  /** Number of proxy-host records retrieved from NPM. */
  proxyHostCount: number;
  /** True when the NPM entity was found but the API was unreachable/failed. */
  degraded: boolean;
  /** Human-readable degradation reason when `degraded === true`. */
  degradeReason?: string;
}

// ---------------------------------------------------------------------------
// Helper: derive the base URL for a discovered reverse-proxy entity
// ---------------------------------------------------------------------------

/**
 * Extract the HTTP base URL for the reverse-proxy entity's own API.
 *
 * NPM runs its management API on port 81 by default. We try:
 * 1. `attributes.api_url` — explicit override (e.g. from a label or config)
 * 2. `attributes.host` + port 81
 * 3. `attributes.ports` array — first port mapping whose host port is 81
 *
 * Returns null when no usable URL can be derived.
 *
 * @param entity - The reverse-proxy service entity.
 * @returns Base URL string (scheme + host + port, no trailing slash), or null.
 */
export function deriveNpmApiBase(entity: Entity): string | null {
  const attrs = entity.attributes;

  // Explicit override wins.
  if (typeof attrs['api_url'] === 'string' && attrs['api_url'] !== '') {
    return attrs['api_url'].replace(/\/$/, '');
  }

  // Build from host attribute.
  const host = typeof attrs['host'] === 'string' ? attrs['host'] : null;
  if (host !== null && host !== '') {
    // NPM management port default: 81
    const port = typeof attrs['management_port'] === 'number' ? attrs['management_port'] : 81;
    return `http://${host}:${port}`;
  }

  // Try to extract from ports array: look for a mapping that exposes port 81.
  const ports = attrs['ports'];
  if (Array.isArray(ports)) {
    for (const p of ports) {
      if (typeof p !== 'string') continue;
      // Common Docker port format: "*:81->81/tcp" or "0.0.0.0:81->81/tcp"
      const m = /^(?:\d+\.\d+\.\d+\.\d+|\*):(\d+)->81\//.exec(p);
      if (m !== null) {
        return `http://localhost:${m[1]}`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: match a route's forward_host:forward_port to a service entity
// ---------------------------------------------------------------------------

/**
 * Attempt to match a proxy-host's forward_host and forward_port to a known
 * service entity in the graph.
 *
 * Matching strategy (generic, invariant #62):
 * 1. Exact `attributes.host` match + port in `attributes.ports`.
 * 2. Service `name` contains the forward_host (case-insensitive substring).
 * 3. `attributes.ports` array includes a mapping to `forward_port`.
 *
 * The first strategy to produce a match wins.
 *
 * @param forwardHost - NPM's configured forward host.
 * @param forwardPort - NPM's configured forward port.
 * @param services    - All service/container entities in the graph.
 * @returns The matched entity, or null.
 */
export function matchForwardTarget(
  forwardHost: string,
  forwardPort: number,
  services: Entity[],
): Entity | null {
  const fh = forwardHost.toLowerCase();
  const fp = String(forwardPort);

  // Strategy 1: exact host attribute match + port in ports.
  for (const svc of services) {
    const host = svc.attributes['host'];
    if (typeof host !== 'string') continue;
    if (host.toLowerCase() !== fh) continue;
    const ports = svc.attributes['ports'];
    if (
      Array.isArray(ports) &&
      (ports as unknown[]).some((p) => typeof p === 'string' && p.includes(fp))
    ) {
      return svc;
    }
  }

  // Strategy 2: service name contains forward_host.
  for (const svc of services) {
    if (svc.name.toLowerCase().includes(fh) || fh.includes(svc.name.toLowerCase())) {
      return svc;
    }
  }

  // Strategy 3: any service whose ports array contains an entry with forward_port.
  for (const svc of services) {
    const ports = svc.attributes['ports'];
    if (
      Array.isArray(ports) &&
      (ports as unknown[]).some((p) => typeof p === 'string' && p.includes(fp))
    ) {
      return svc;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// NpmAdapter
// ---------------------------------------------------------------------------

/**
 * Logger interface for the NPM adapter.
 */
export interface NpmAdapterLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: NpmAdapterLogger = {};

/**
 * Adapter options.
 */
export interface NpmAdapterOptions {
  /**
   * Override fetch (for tests — never make live HTTP calls in unit tests).
   * Defaults to globalThis.fetch.
   */
  fetchImpl?: FetchFn;
  /**
   * Clock override for deterministic timestamps in tests.
   * Defaults to `() => new Date().toISOString()`.
   */
  clock?: () => string;
  /**
   * HTTP request timeout in milliseconds. Default 10 000.
   */
  timeoutMs?: number;
  /**
   * Logger override.
   */
  logger?: NpmAdapterLogger;
}

/**
 * Discovers reverse-proxy route entities and edges from the Nginx Proxy
 * Manager API. Fully generic — no hard-coded service or route names.
 *
 * The adapter:
 * 1. Reads all service entities with `attributes.role === 'reverse-proxy'`
 *    from the graph store.
 * 2. For each reverse-proxy entity, authenticates to the NPM API using the
 *    token in `NPM_API_TOKEN` env var (never hard-coded).
 * 3. Lists all proxy hosts (`GET /api/nginx/proxy-hosts`).
 * 4. Converts each proxy host to a `route` entity and attempts to match it
 *    to a target service entity via `matchForwardTarget`.
 * 5. Emits `routes-to` edges for matched routes.
 *
 * Degrades gracefully when the API is unreachable.
 */
export class NpmAdapter {
  private readonly graphStore: GraphStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchFn;
  private readonly clock: () => string;
  private readonly timeoutMs: number;
  private readonly logger: NpmAdapterLogger;

  /**
   * @param graphStore - Source graph (read) and target (for callers who upsert results).
   * @param env        - Process environment (reads `NPM_API_TOKEN`).
   * @param opts       - Optional overrides.
   */
  constructor(
    graphStore: GraphStore,
    env: NodeJS.ProcessEnv,
    opts: NpmAdapterOptions = {},
  ) {
    this.graphStore = graphStore;
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Discover reverse-proxy routes from the NPM API and return entities + edges.
   *
   * Never throws. All errors are caught and reflected in `result.degraded`.
   *
   * @returns Route entities and edges, plus diagnostic fields.
   */
  async discover(): Promise<NpmAdapterResult> {
    const now = this.clock();

    // Step 1: find the reverse-proxy entity generically.
    const allServices = await this.graphStore.entitiesByKind('service');
    const proxyEntities = allServices.filter(
      (e) => e.attributes['role'] === 'reverse-proxy',
    );

    if (proxyEntities.length === 0) {
      this.logger.debug?.('npm_adapter_no_proxy_entity', {});
      return { entities: [], edges: [], proxyHostCount: 0, degraded: false };
    }

    // Use the first reverse-proxy entity found.
    const proxyEntity = proxyEntities[0]!;

    // Step 2: derive the NPM API base URL.
    const apiBase = deriveNpmApiBase(proxyEntity);
    if (apiBase === null) {
      this.logger.warn?.('npm_adapter_no_api_base', { entityId: proxyEntity.id });
      return {
        entities: [],
        edges: [],
        proxyHostCount: 0,
        degraded: true,
        degradeReason: 'cannot derive NPM API base URL from entity attributes',
      };
    }

    // Step 3: acquire an API token.
    const token = this.env['NPM_API_TOKEN'] ?? '';
    if (token === '') {
      this.logger.warn?.('npm_adapter_no_token', { entityId: proxyEntity.id });
      return {
        entities: [],
        edges: [],
        proxyHostCount: 0,
        degraded: true,
        degradeReason: 'NPM_API_TOKEN not set; cannot query NPM API',
      };
    }

    // Step 4: fetch proxy hosts.
    let proxyHosts: NpmProxyHost[];
    try {
      proxyHosts = await this.fetchProxyHosts(apiBase, token);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('npm_adapter_api_error', { entityId: proxyEntity.id, error: msg });
      return {
        entities: [],
        edges: [],
        proxyHostCount: 0,
        degraded: true,
        degradeReason: `NPM API unreachable: ${msg}`,
      };
    }

    // Step 5: load all container entities for target matching (in addition to services).
    const containerEntities = await this.graphStore.entitiesByKind('container');
    const allServiceEntities = [...allServices, ...containerEntities];

    // Step 6: convert proxy hosts to route entities + edges.
    const entities: Entity[] = [];
    const edges: Edge[] = [];

    for (const ph of proxyHosts) {
      // Build one route entity per domain_name (NPM allows multiple per record).
      const domains = ph.domain_names.length > 0 ? ph.domain_names : [`id-${ph.id}`];

      for (const domain of domains) {
        const routeId = `route:npm:${ph.id}:${domain}`;

        const routeEntity: Entity = {
          id: routeId,
          kind: 'route',
          name: domain,
          attributes: {
            source_id: ph.id,
            domain,
            forward_host: ph.forward_host,
            forward_port: ph.forward_port,
            forward_scheme: ph.forward_scheme,
            ssl_forced: ph.ssl_forced,
            has_ssl: ph.certificate_id !== undefined && ph.certificate_id !== 0,
            enabled: ph.enabled,
            reverse_proxy_id: proxyEntity.id,
          },
          source: 'npm',
          discovered_at: now,
          last_seen: now,
          status: 'active',
        };
        entities.push(routeEntity);

        // Edge: route → reverse-proxy (route is served-by proxy)
        edges.push({
          id: `routes-to:${routeId}:${proxyEntity.id}:proxy`,
          from: routeId,
          to: proxyEntity.id,
          type: 'routes-to',
          attributes: { role: 'served-by' },
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });

        // Attempt to match the forward target to a service entity.
        const target = matchForwardTarget(
          ph.forward_host,
          ph.forward_port,
          allServiceEntities,
        );
        if (target !== null) {
          edges.push({
            id: `routes-to:${routeId}:${target.id}`,
            from: routeId,
            to: target.id,
            type: 'routes-to',
            attributes: {
              forward_host: ph.forward_host,
              forward_port: ph.forward_port,
            },
            discovered_at: now,
            last_seen: now,
            status: 'active',
          });
          this.logger.debug?.('npm_adapter_route_matched', {
            routeId,
            domain,
            targetId: target.id,
          });
        }
      }
    }

    this.logger.info?.('npm_adapter_complete', {
      proxyEntityId: proxyEntity.id,
      proxyHostCount: proxyHosts.length,
      routeEntities: entities.length,
      routeEdges: edges.length,
    });

    return {
      entities,
      edges,
      proxyHostCount: proxyHosts.length,
      degraded: false,
    };
  }

  /**
   * Fetch all proxy hosts from the NPM API.
   *
   * @param apiBase - Base URL (e.g. `http://host:81`).
   * @param token   - Bearer token for the NPM API.
   * @returns Array of proxy-host records.
   * @throws Error on network failure or non-200 response.
   */
  private async fetchProxyHosts(apiBase: string, token: string): Promise<NpmProxyHost[]> {
    const url = `${apiBase}/api/nginx/proxy-hosts`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (!resp.ok) {
      throw new Error(`NPM API returned HTTP ${resp.status} from ${url}`);
    }

    const body = (await resp.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error(`NPM API returned unexpected shape from ${url}`);
    }

    return body as NpmProxyHost[];
  }
}
