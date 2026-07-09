/**
 * TopologyEnricher: orchestrator for topology discovery (issue #29).
 *
 * Runs the three topology passes in sequence and upserts all discovered
 * entities and edges into the GraphStore:
 *   1. NPM reverse-proxy routes (via NpmAdapter)
 *   2. Vault secret-tree structure (via VaultAdapter) — keys only
 *   3. Derived dependency edges (via DependencyEdgeDeriver) — graph analysis
 *
 * Dynamic-first invariant (#62):
 * - All passes are generic — no hard-coded service names or paths.
 * - Each pass degrades gracefully if the relevant service is absent or
 *   unreachable.
 * - Results from all three passes are written into the shared GraphStore
 *   via upsert so re-running is idempotent.
 */

import type { GraphStore } from '../graph-store.js';
import { NpmAdapter, type NpmAdapterOptions } from './npm-adapter.js';
import { VaultAdapter, type VaultAdapterOptions } from './vault-adapter.js';
import { DependencyEdgeDeriver, type DepEdgesOptions } from './dep-edges.js';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TopologyPassResult {
  /** True when the pass completed without fatal error. */
  ok: boolean;
  /** Error message when `ok === false`. */
  error?: string;
  /** Number of entities upserted by this pass. */
  entitiesUpserted: number;
  /** Number of edges upserted by this pass. */
  edgesUpserted: number;
  /** When the underlying adapter degraded (service absent/unreachable). */
  degraded?: boolean;
  /** Degradation reason string when `degraded === true`. */
  degradeReason?: string;
}

export interface TopologyEnrichmentResult {
  /** Results of the NPM routes pass. */
  npm: TopologyPassResult;
  /** Results of the Vault secret-tree pass. */
  vault: TopologyPassResult;
  /** Results of the dependency-edge derivation pass. */
  deps: TopologyPassResult;
  /** Total entities upserted across all passes. */
  totalEntitiesUpserted: number;
  /** Total edges upserted across all passes. */
  totalEdgesUpserted: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface TopologyEnricherLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: TopologyEnricherLogger = {};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TopologyEnricherOptions {
  /**
   * Clock override for deterministic timestamps in tests.
   * Defaults to `() => new Date().toISOString()`.
   */
  clock?: () => string;
  /**
   * Logger override.
   */
  logger?: TopologyEnricherLogger;
  /**
   * Options forwarded to the NpmAdapter.
   */
  npm?: NpmAdapterOptions;
  /**
   * Options forwarded to the VaultAdapter.
   */
  vault?: VaultAdapterOptions;
  /**
   * Options forwarded to the DependencyEdgeDeriver.
   */
  deps?: DepEdgesOptions;
}

// ---------------------------------------------------------------------------
// TopologyEnricher
// ---------------------------------------------------------------------------

/**
 * Orchestrates the three topology-enrichment passes and upserts results
 * into the graph store.
 *
 * Does not throw — per-pass errors are caught and recorded in the result.
 */
export class TopologyEnricher {
  private readonly graphStore: GraphStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: TopologyEnricherLogger;
  private readonly opts: TopologyEnricherOptions;

  /**
   * @param graphStore - Target graph store (entities + edges are upserted here).
   * @param env        - Process environment (passed to npm/vault adapters).
   * @param opts       - Optional overrides for clock, logger, and sub-adapters.
   */
  constructor(
    graphStore: GraphStore,
    env: NodeJS.ProcessEnv,
    opts: TopologyEnricherOptions = {},
  ) {
    this.graphStore = graphStore;
    this.env = env;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.opts = opts;
  }

  /**
   * Run all topology passes and upsert results into the graph store.
   *
   * Passes run sequentially; the dep-edges pass runs last so it can see
   * entities emitted by the npm and vault passes.
   *
   * Never throws.
   *
   * @returns Detailed result for each pass and totals.
   */
  async enrich(): Promise<TopologyEnrichmentResult> {
    const npmResult = await this.runNpmPass();
    const vaultResult = await this.runVaultPass();
    const depsResult = await this.runDepsPass();

    const totalEntitiesUpserted =
      npmResult.entitiesUpserted + vaultResult.entitiesUpserted + depsResult.entitiesUpserted;
    const totalEdgesUpserted =
      npmResult.edgesUpserted + vaultResult.edgesUpserted + depsResult.edgesUpserted;

    this.logger.info?.('topology_enricher_complete', {
      totalEntitiesUpserted,
      totalEdgesUpserted,
      npmOk: npmResult.ok,
      vaultOk: vaultResult.ok,
      depsOk: depsResult.ok,
    });

    return {
      npm: npmResult,
      vault: vaultResult,
      deps: depsResult,
      totalEntitiesUpserted,
      totalEdgesUpserted,
    };
  }

  /**
   * Run the NPM reverse-proxy routes pass.
   */
  private async runNpmPass(): Promise<TopologyPassResult> {
    try {
      const adapter = new NpmAdapter(this.graphStore, this.env, {
        ...(this.opts.npm ?? {}),
        ...(this.opts.clock !== undefined ? { clock: this.opts.clock } : {}),
        logger: this.logger,
      });
      const result = await adapter.discover();

      // Upsert entities and edges.
      let entitiesUpserted = 0;
      let edgesUpserted = 0;
      const errors: string[] = [];

      for (const entity of result.entities) {
        try {
          await this.graphStore.upsertEntity(entity);
          entitiesUpserted++;
        } catch (err) {
          errors.push(`entity ${entity.id}: ${(err as Error).message}`);
        }
      }
      for (const edge of result.edges) {
        try {
          await this.graphStore.upsertEdge(edge);
          edgesUpserted++;
        } catch (err) {
          errors.push(`edge ${edge.id}: ${(err as Error).message}`);
        }
      }

      if (errors.length > 0) {
        this.logger.warn?.('topology_npm_upsert_errors', { errors });
      }

      return {
        ok: true,
        entitiesUpserted,
        edgesUpserted,
        degraded: result.degraded,
        ...(result.degradeReason !== undefined ? { degradeReason: result.degradeReason } : {}),
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('topology_npm_pass_error', { error: msg });
      return { ok: false, error: msg, entitiesUpserted: 0, edgesUpserted: 0 };
    }
  }

  /**
   * Run the Vault secret-tree pass.
   */
  private async runVaultPass(): Promise<TopologyPassResult> {
    try {
      const adapter = new VaultAdapter(this.graphStore, this.env, {
        ...(this.opts.vault ?? {}),
        ...(this.opts.clock !== undefined ? { clock: this.opts.clock } : {}),
        logger: this.logger,
      });
      const result = await adapter.discover();

      // Upsert entities and edges.
      let entitiesUpserted = 0;
      let edgesUpserted = 0;
      const errors: string[] = [];

      for (const entity of result.entities) {
        try {
          await this.graphStore.upsertEntity(entity);
          entitiesUpserted++;
        } catch (err) {
          errors.push(`entity ${entity.id}: ${(err as Error).message}`);
        }
      }
      for (const edge of result.edges) {
        try {
          await this.graphStore.upsertEdge(edge);
          edgesUpserted++;
        } catch (err) {
          errors.push(`edge ${edge.id}: ${(err as Error).message}`);
        }
      }

      if (errors.length > 0) {
        this.logger.warn?.('topology_vault_upsert_errors', { errors });
      }

      return {
        ok: true,
        entitiesUpserted,
        edgesUpserted,
        degraded: result.degraded,
        ...(result.degradeReason !== undefined ? { degradeReason: result.degradeReason } : {}),
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('topology_vault_pass_error', { error: msg });
      return { ok: false, error: msg, entitiesUpserted: 0, edgesUpserted: 0 };
    }
  }

  /**
   * Run the derived dependency-edge pass.
   */
  private async runDepsPass(): Promise<TopologyPassResult> {
    try {
      const deriver = new DependencyEdgeDeriver(this.graphStore, {
        ...(this.opts.deps ?? {}),
        ...(this.opts.clock !== undefined ? { clock: this.opts.clock } : {}),
        logger: this.logger,
      });
      const result = await deriver.derive();

      let edgesUpserted = 0;
      const errors: string[] = [];

      for (const edge of result.edges) {
        try {
          await this.graphStore.upsertEdge(edge);
          edgesUpserted++;
        } catch (err) {
          errors.push(`edge ${edge.id}: ${(err as Error).message}`);
        }
      }

      if (errors.length > 0) {
        this.logger.warn?.('topology_deps_upsert_errors', { errors });
      }

      return {
        ok: true,
        entitiesUpserted: 0, // dep pass emits edges only
        edgesUpserted,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn?.('topology_deps_pass_error', { error: msg });
      return { ok: false, error: msg, entitiesUpserted: 0, edgesUpserted: 0 };
    }
  }
}
