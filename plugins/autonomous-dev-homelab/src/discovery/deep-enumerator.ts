/**
 * DeepEnumerator: orchestrates post-fingerprint deep enumeration of all
 * known platforms in the inventory graph.
 *
 * Implements issue #27 §"DeepEnumerator orchestrator":
 *
 *  - Iterates every platform in the InventoryManager.
 *  - For each platform, looks up the registered PlatformEnumerator by
 *    `platform.type` (dynamic dispatch — no hard-coded list of platforms).
 *  - Opens a connection from the pool, runs the enumerator, and upserts
 *    all returned entities and edges into the GraphStore.
 *  - Unreachable or unsupported platforms are logged and skipped; they
 *    never abort the run (graceful degradation, issue #27 AC).
 *
 * Re-running `enumerate()` on a changed environment:
 *  - New entities/edges are inserted.
 *  - Existing entities/edges are merged (last_seen refreshed).
 *  - Entities not seen this pass are left to the refresh loop (#31).
 *
 * Dynamic-first (invariant #62):
 *  - Dispatch is by `platform.type` string, not a switch/enum. A new
 *    platform type just needs a registered enumerator.
 *  - No homelab-specific service or node names appear in this file.
 */

import type { ConnectionPool } from '../connection/pool.js';
import type { GraphStore } from './graph-store.js';
import type { InventoryManager } from './inventory.js';
import type { Platform } from './inventory-types.js';
import { getEnumerator } from './enumerator.js';

// ---------------------------------------------------------------------------
// Logger interface (narrow — callers inject their logger)
// ---------------------------------------------------------------------------

export interface DeepEnumeratorLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: DeepEnumeratorLogger = {};

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

export interface PlatformEnumerationSummary {
  platformId: string;
  platformKind: string;
  /** True if enumeration succeeded (even partially). */
  ok: boolean;
  entitiesUpserted: number;
  edgesUpserted: number;
  /** Error message when `ok === false`. */
  error?: string;
}

export interface DeepEnumerationResult {
  summaries: PlatformEnumerationSummary[];
  totalEntities: number;
  totalEdges: number;
}

// ---------------------------------------------------------------------------
// DeepEnumerator
// ---------------------------------------------------------------------------

/**
 * Orchestrates a full deep-enumeration pass across all known platforms.
 */
export class DeepEnumerator {
  private readonly inventoryManager: InventoryManager;
  private readonly pool: ConnectionPool;
  private readonly graphStore: GraphStore;
  private readonly logger: DeepEnumeratorLogger;
  /** Override for tests. */
  private readonly clock: () => string;

  /**
   * @param inventoryManager - Source of known platforms to enumerate.
   * @param pool             - Connection pool; `getConnection(platformId)` is called per platform.
   * @param graphStore       - Target graph store for upserted entities/edges.
   * @param opts.logger      - Optional structured logger.
   * @param opts.clock       - Optional clock override (returns ISO-8601 string).
   */
  constructor(
    inventoryManager: InventoryManager,
    pool: ConnectionPool,
    graphStore: GraphStore,
    opts: { logger?: DeepEnumeratorLogger; clock?: () => string } = {},
  ) {
    this.inventoryManager = inventoryManager;
    this.pool = pool;
    this.graphStore = graphStore;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Enumerate all platforms in the inventory and upsert results into the graph.
   *
   * Does NOT throw. Every per-platform error is caught, logged, and
   * reflected in the summary with `ok: false`. The caller inspects
   * `summaries` to understand which platforms succeeded.
   *
   * @param opts.platformFilter - Optional allowlist of platform IDs to
   *   enumerate; when absent all platforms are enumerated.
   * @returns A summary of the enumeration pass.
   */
  async enumerate(opts: { platformFilter?: string[] } = {}): Promise<DeepEnumerationResult> {
    const now = this.clock();
    const platforms = await this.inventoryManager.listPlatforms();
    const summaries: PlatformEnumerationSummary[] = [];
    let totalEntities = 0;
    let totalEdges = 0;

    for (const platform of platforms) {
      if (opts.platformFilter !== undefined && !opts.platformFilter.includes(platform.id)) {
        continue;
      }
      const summary = await this.enumeratePlatform(platform, now);
      summaries.push(summary);
      if (summary.ok) {
        totalEntities += summary.entitiesUpserted;
        totalEdges += summary.edgesUpserted;
      }
    }

    this.logger.info?.('deep_enumeration_complete', {
      platforms: summaries.length,
      ok: summaries.filter((s) => s.ok).length,
      failed: summaries.filter((s) => !s.ok).length,
      total_entities: totalEntities,
      total_edges: totalEdges,
    });

    return { summaries, totalEntities, totalEdges };
  }

  /**
   * Enumerate a single platform. Internal; does not throw.
   */
  private async enumeratePlatform(
    platform: Platform,
    now: string,
  ): Promise<PlatformEnumerationSummary> {
    const { id: platformId, type: platformKind } = platform;

    const enumerator = getEnumerator(platformKind);
    if (enumerator === undefined) {
      this.logger.debug?.('deep_enumerator_no_handler', { platformId, platformKind });
      return {
        platformId,
        platformKind,
        ok: false,
        entitiesUpserted: 0,
        edgesUpserted: 0,
        error: `no enumerator registered for platform kind '${platformKind}'`,
      };
    }

    let connection;
    try {
      connection = await this.pool.getConnection(platformId);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('deep_enumerator_connect_failed', { platformId, platformKind, error: msg });
      return {
        platformId,
        platformKind,
        ok: false,
        entitiesUpserted: 0,
        edgesUpserted: 0,
        error: `connection failed: ${msg}`,
      };
    }

    let result;
    try {
      result = await enumerator.enumerate({ connection, platform, now });
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('deep_enumerator_enumerate_failed', {
        platformId,
        platformKind,
        error: msg,
      });
      return {
        platformId,
        platformKind,
        ok: false,
        entitiesUpserted: 0,
        edgesUpserted: 0,
        error: `enumeration failed: ${msg}`,
      };
    }

    // Upsert all entities and edges. Errors here surface (schema violations
    // are programming errors, not runtime failures) but are caught so one
    // bad entity doesn't abort the whole platform pass.
    let entitiesUpserted = 0;
    let edgesUpserted = 0;
    const upsertErrors: string[] = [];

    for (const entity of result.entities) {
      try {
        await this.graphStore.upsertEntity(entity);
        entitiesUpserted++;
      } catch (err) {
        upsertErrors.push(`entity ${entity.id}: ${(err as Error).message}`);
      }
    }
    for (const edge of result.edges) {
      try {
        await this.graphStore.upsertEdge(edge);
        edgesUpserted++;
      } catch (err) {
        upsertErrors.push(`edge ${edge.id}: ${(err as Error).message}`);
      }
    }

    if (upsertErrors.length > 0) {
      this.logger.warn?.('deep_enumerator_upsert_errors', {
        platformId,
        platformKind,
        errors: upsertErrors,
      });
    }

    this.logger.info?.('deep_enumerator_platform_done', {
      platformId,
      platformKind,
      entities: entitiesUpserted,
      edges: edgesUpserted,
    });

    return {
      platformId,
      platformKind,
      ok: true,
      entitiesUpserted,
      edgesUpserted,
    };
  }
}
