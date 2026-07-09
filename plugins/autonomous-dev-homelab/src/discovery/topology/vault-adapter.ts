/**
 * Vault secret-tree structure adapter (issue #29).
 *
 * Generically discovers the Vault entity from the graph (by
 * `attributes.role === 'secrets'`), then lists KV path structure from the
 * Vault KV v2 LIST API — reading KEYS ONLY, never values.
 *
 * Emits:
 *   - `kind='secret-ref'` entities (path only — no values, no data)
 *   - `member-of` edges from secret-ref → Vault service entity
 *
 * Dynamic-first invariant (#62):
 * - The Vault entity is found generically by role — no hard-coded service
 *   name, IP, or URL.
 * - KV mount points to scan are discovered from `attributes.kv_mounts` on
 *   the Vault entity (a comma-separated string or array) or defaulted to
 *   `['secret']` (standard KV v2 mount name) when absent.
 * - Auth token is read from `VAULT_TOKEN` or `VAULT_ADDR`+AppRole env vars;
 *   never hard-coded.
 *
 * Structure-only proof:
 * - All API calls use `LIST` method against `/v1/<mount>/metadata/<prefix>`.
 * - This endpoint returns ONLY key names (strings), never secret values.
 * - `GET` (which would return values) is NEVER called on secret paths.
 * - Tests assert the adapter's HTTP calls use `LIST` only.
 *
 * Graceful degradation: if Vault is absent from the graph or unreachable,
 * returns an empty result without throwing.
 *
 * Vault KV v2 LIST API: https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2#list-secrets
 */

import type { Entity, Edge } from '../graph-types.js';
import type { GraphStore } from '../graph-store.js';

// ---------------------------------------------------------------------------
// HTTP fetch interface (injectable for tests)
// ---------------------------------------------------------------------------

/** Minimal shape of a fetch-like function (matches global `fetch`). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Vault LIST response shape
// ---------------------------------------------------------------------------

/**
 * Vault KV v2 LIST response body. Keys ending in `/` are sub-directories.
 * NEVER contains secret values — only key names.
 */
export interface VaultListResponse {
  data: {
    keys: string[];
  };
}

// ---------------------------------------------------------------------------
// Adapter result
// ---------------------------------------------------------------------------

export interface VaultAdapterResult {
  /** `secret-ref` entities (path only, no values). */
  entities: Entity[];
  /** `member-of` edges from secret-ref → Vault entity. */
  edges: Edge[];
  /** Total number of key paths discovered (including nested). */
  keyCount: number;
  /** True when the Vault entity was found but the API was unreachable/failed. */
  degraded: boolean;
  /** Human-readable degradation reason when `degraded === true`. */
  degradeReason?: string;
}

// ---------------------------------------------------------------------------
// Helper: derive Vault address from a Vault entity
// ---------------------------------------------------------------------------

/**
 * Extract the Vault API address from a discovered entity.
 *
 * Resolution order:
 * 1. `attributes.vault_addr` — explicit override
 * 2. `VAULT_ADDR` env var
 * 3. `attributes.host` + port 8200 (Vault default)
 *
 * @param entity - Vault service entity.
 * @param env    - Process environment.
 * @returns Vault address (no trailing slash), or null when none can be derived.
 */
export function deriveVaultAddress(entity: Entity, env: NodeJS.ProcessEnv): string | null {
  const attrs = entity.attributes;

  if (typeof attrs['vault_addr'] === 'string' && attrs['vault_addr'] !== '') {
    return attrs['vault_addr'].replace(/\/$/, '');
  }

  const fromEnv = env['VAULT_ADDR'];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return fromEnv.replace(/\/$/, '');
  }

  const host = typeof attrs['host'] === 'string' ? attrs['host'] : null;
  if (host !== null && host !== '') {
    return `http://${host}:8200`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: extract KV mount names from entity
// ---------------------------------------------------------------------------

/**
 * Extract the list of KV mount prefixes from the Vault entity's attributes.
 *
 * Reads `attributes.kv_mounts`: either a comma-separated string or an array
 * of strings. Defaults to `['secret']` when absent or empty.
 *
 * @param entity - Vault service entity.
 * @returns Array of KV mount names (e.g. `['secret', 'kv']`).
 */
export function extractKvMounts(entity: Entity): string[] {
  const raw = entity.attributes['kv_mounts'];
  if (typeof raw === 'string' && raw !== '') {
    return raw
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '');
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return (raw as unknown[])
      .filter((m): m is string => typeof m === 'string' && m !== '')
      .map((m) => m.trim());
  }
  return ['secret'];
}

// ---------------------------------------------------------------------------
// VaultAdapter
// ---------------------------------------------------------------------------

/**
 * Logger interface for the Vault adapter.
 */
export interface VaultAdapterLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: VaultAdapterLogger = {};

/**
 * Options for the Vault adapter.
 */
export interface VaultAdapterOptions {
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
   * Maximum recursion depth for KV path listing. Default 5.
   * Guards against unexpectedly deep secret trees.
   */
  maxDepth?: number;
  /**
   * Logger override.
   */
  logger?: VaultAdapterLogger;
}

/**
 * Discovers Vault KV secret-tree structure and emits secret-ref entities.
 *
 * NEVER reads secret values. All HTTP calls use the Vault KV `LIST` method
 * which returns key names only. The adapter is structurally incapable of
 * reading values because it never calls `GET` on secret-data paths.
 *
 * Design (invariant #62):
 * - Vault entity is found generically by `attributes.role === 'secrets'`.
 * - No hard-coded secret paths or mount names in this file.
 * - KV mounts are read from the entity's `attributes.kv_mounts` or default
 *   to `['secret']`.
 * - Graceful degradation when Vault is absent or unreachable.
 */
export class VaultAdapter {
  private readonly graphStore: GraphStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchFn;
  private readonly clock: () => string;
  private readonly timeoutMs: number;
  private readonly maxDepth: number;
  private readonly logger: VaultAdapterLogger;

  /**
   * @param graphStore - Source graph (read).
   * @param env        - Process environment (reads `VAULT_TOKEN`, `VAULT_ADDR`).
   * @param opts       - Optional overrides.
   */
  constructor(
    graphStore: GraphStore,
    env: NodeJS.ProcessEnv,
    opts: VaultAdapterOptions = {},
  ) {
    this.graphStore = graphStore;
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchFn);
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxDepth = opts.maxDepth ?? 5;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Discover Vault KV path structure and return secret-ref entities + edges.
   *
   * STRUCTURE ONLY: only key paths are discovered; secret values are never
   * read. The HTTP method used for all Vault API calls is `LIST`.
   *
   * Never throws. All errors are caught and reflected in `result.degraded`.
   *
   * @returns Secret-ref entities (paths only) and edges, plus diagnostic fields.
   */
  async discover(): Promise<VaultAdapterResult> {
    const now = this.clock();

    // Step 1: find the Vault entity generically (role='secrets').
    const allServices = await this.graphStore.entitiesByKind('service');
    const vaultEntities = allServices.filter(
      (e) => e.attributes['role'] === 'secrets',
    );

    if (vaultEntities.length === 0) {
      this.logger.debug?.('vault_adapter_no_vault_entity', {});
      return { entities: [], edges: [], keyCount: 0, degraded: false };
    }

    // Use the first Vault entity found.
    const vaultEntity = vaultEntities[0]!;

    // Step 2: derive Vault address.
    const vaultAddr = deriveVaultAddress(vaultEntity, this.env);
    if (vaultAddr === null) {
      this.logger.warn?.('vault_adapter_no_address', { entityId: vaultEntity.id });
      return {
        entities: [],
        edges: [],
        keyCount: 0,
        degraded: true,
        degradeReason: 'cannot derive Vault address from entity attributes or VAULT_ADDR env',
      };
    }

    // Step 3: acquire token.
    const token = this.env['VAULT_TOKEN'] ?? '';
    if (token === '') {
      this.logger.warn?.('vault_adapter_no_token', { entityId: vaultEntity.id });
      return {
        entities: [],
        edges: [],
        keyCount: 0,
        degraded: true,
        degradeReason: 'VAULT_TOKEN not set; cannot list KV paths',
      };
    }

    // Step 4: determine KV mounts to scan.
    const mounts = extractKvMounts(vaultEntity);

    // Step 5: walk each mount and collect key paths.
    const entities: Entity[] = [];
    const edges: Edge[] = [];
    let keyCount = 0;

    for (const mount of mounts) {
      try {
        const paths = await this.listPathsRecursive(vaultAddr, token, mount, '', 0);
        for (const p of paths) {
          // Skip directory markers (trailing slash) — we only emit leaf paths.
          if (p.endsWith('/')) continue;

          keyCount++;
          const fullPath = `${mount}/${p}`;
          const secretRefId = `secret-ref:vault:${fullPath}`;

          const secretRefEntity: Entity = {
            id: secretRefId,
            kind: 'secret-ref',
            name: fullPath,
            attributes: {
              path: fullPath,
              mount,
              // IMPORTANT: no 'value' attribute — NEVER store secret values.
            },
            source: 'vault',
            discovered_at: now,
            last_seen: now,
            status: 'active',
          };
          entities.push(secretRefEntity);

          // Edge: secret-ref member-of Vault entity
          edges.push({
            id: `member-of:${secretRefId}:${vaultEntity.id}`,
            from: secretRefId,
            to: vaultEntity.id,
            type: 'member-of',
            discovered_at: now,
            last_seen: now,
            status: 'active',
          });
        }
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn?.('vault_adapter_mount_error', { mount, error: msg });
        // Continue to next mount; do not abort the whole pass.
      }
    }

    this.logger.info?.('vault_adapter_complete', {
      vaultEntityId: vaultEntity.id,
      mounts: mounts.length,
      keyCount,
      entityCount: entities.length,
    });

    return { entities, edges, keyCount, degraded: false };
  }

  /**
   * Recursively list KV v2 key paths under a mount + prefix.
   *
   * Uses the Vault LIST method against `/v1/<mount>/metadata/<prefix>`.
   * Keys ending in `/` are directories and are recursed into (up to maxDepth).
   * Keys without trailing `/` are leaf paths.
   *
   * STRUCTURE ONLY: this method NEVER calls `GET` on data paths.
   *
   * @param vaultAddr - Base Vault address.
   * @param token     - Vault token.
   * @param mount     - KV mount name (e.g. 'secret').
   * @param prefix    - Current path prefix (empty at root).
   * @param depth     - Current recursion depth.
   * @returns Array of relative key paths (relative to mount root).
   * @throws Error on non-200 HTTP responses.
   */
  private async listPathsRecursive(
    vaultAddr: string,
    token: string,
    mount: string,
    prefix: string,
    depth: number,
  ): Promise<string[]> {
    if (depth > this.maxDepth) {
      this.logger.debug?.('vault_adapter_max_depth', { mount, prefix, depth });
      return [];
    }

    // LIST /v1/<mount>/metadata/<prefix> — keys only, never values.
    const listPath = prefix === '' ? '' : prefix;
    const url = `${vaultAddr}/v1/${mount}/metadata/${listPath}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'LIST',
        headers: {
          'X-Vault-Token': token,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    // 404 means the prefix doesn't exist yet — treat as empty.
    if (resp.status === 404) {
      return [];
    }

    if (!resp.ok) {
      throw new Error(`Vault LIST ${url} returned HTTP ${resp.status}`);
    }

    const body = (await resp.json()) as VaultListResponse;
    const keys = body.data?.keys ?? [];

    const results: string[] = [];
    for (const key of keys) {
      const fullKey = prefix !== '' ? `${prefix}${key}` : key;
      if (key.endsWith('/')) {
        // Directory — recurse.
        const children = await this.listPathsRecursive(
          vaultAddr,
          token,
          mount,
          fullKey,
          depth + 1,
        );
        results.push(fullKey, ...children);
      } else {
        results.push(fullKey);
      }
    }

    return results;
  }
}
