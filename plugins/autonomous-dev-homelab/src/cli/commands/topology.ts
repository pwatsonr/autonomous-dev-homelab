/**
 * `autonomous-dev-homelab inventory topology` command handler (issue #29).
 *
 * Runs the topology-enrichment passes (NPM routes, Vault secret tree,
 * derived dependency edges) and upserts results into the inventory graph.
 *
 * Usage:
 *   homelab inventory topology [--json]
 *
 * - `--json`: emit machine-readable JSON summary.
 *
 * Design (dynamic-first invariant, issue #62):
 * - No hard-coded service names, routes, or secret paths in this file.
 * - All discovery is driven generically by the TopologyEnricher.
 * - Degrades gracefully: individual passes that fail (NPM/Vault unreachable)
 *   are reported in the summary without aborting other passes.
 *
 * Exit codes:
 *   EXIT_OK      (0) — all passes succeeded (degraded-but-not-failed counts as ok)
 *   EXIT_PARTIAL (3) — some passes failed with errors
 *   EXIT_USAGE   (1) — fatal error initialising the enricher
 */

import type { TopologyEnricher, TopologyEnrichmentResult } from '../../discovery/topology/index.js';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface TopologyArgs {
  /** Emit machine-readable JSON instead of human-readable output. */
  json?: boolean;
}

export interface TopologyDeps {
  topologyEnricher: TopologyEnricher;
  streams?: OutputStreams;
}

/**
 * Run topology enrichment and upsert results into the graph store.
 *
 * @param args - CLI arguments.
 * @param deps - Injected dependencies (testable).
 * @returns Exit code.
 */
export async function runTopology(args: TopologyArgs, deps: TopologyDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  let result: TopologyEnrichmentResult;
  try {
    result = await deps.topologyEnricher.enrich();
  } catch (err) {
    printError(`topology enrichment failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  // Determine overall status.
  const failedPasses = [result.npm, result.vault, result.deps].filter((p) => !p.ok);

  if (jsonMode) {
    printJson(
      {
        npm: {
          ok: result.npm.ok,
          entities_upserted: result.npm.entitiesUpserted,
          edges_upserted: result.npm.edgesUpserted,
          degraded: result.npm.degraded ?? false,
          ...(result.npm.degradeReason !== undefined
            ? { degrade_reason: result.npm.degradeReason }
            : {}),
          ...(result.npm.error !== undefined ? { error: result.npm.error } : {}),
        },
        vault: {
          ok: result.vault.ok,
          entities_upserted: result.vault.entitiesUpserted,
          edges_upserted: result.vault.edgesUpserted,
          degraded: result.vault.degraded ?? false,
          ...(result.vault.degradeReason !== undefined
            ? { degrade_reason: result.vault.degradeReason }
            : {}),
          ...(result.vault.error !== undefined ? { error: result.vault.error } : {}),
        },
        deps: {
          ok: result.deps.ok,
          edges_upserted: result.deps.edgesUpserted,
          ...(result.deps.error !== undefined ? { error: result.deps.error } : {}),
        },
        total_entities_upserted: result.totalEntitiesUpserted,
        total_edges_upserted: result.totalEdgesUpserted,
      },
      streams,
    );
  } else {
    const npmStatus = result.npm.ok
      ? result.npm.degraded === true
        ? `degraded (${result.npm.degradeReason ?? 'unreachable'})`
        : `ok — ${result.npm.entitiesUpserted} routes, ${result.npm.edgesUpserted} edges`
      : `FAILED — ${result.npm.error ?? 'unknown error'}`;

    const vaultStatus = result.vault.ok
      ? result.vault.degraded === true
        ? `degraded (${result.vault.degradeReason ?? 'unreachable'})`
        : `ok — ${result.vault.entitiesUpserted} secret-refs, ${result.vault.edgesUpserted} edges`
      : `FAILED — ${result.vault.error ?? 'unknown error'}`;

    const depsStatus = result.deps.ok
      ? `ok — ${result.deps.edgesUpserted} dependency edges`
      : `FAILED — ${result.deps.error ?? 'unknown error'}`;

    streams.stdout(`Topology enrichment:\n`);
    streams.stdout(`  npm (reverse-proxy routes): ${npmStatus}\n`);
    streams.stdout(`  vault (secret-tree):         ${vaultStatus}\n`);
    streams.stdout(`  deps (dependency edges):     ${depsStatus}\n`);
    streams.stdout(
      `\nTotal: ${result.totalEntitiesUpserted} entities upserted, ` +
        `${result.totalEdgesUpserted} edges upserted.\n`,
    );

    if (failedPasses.length > 0) {
      for (const p of failedPasses) {
        if (p.error !== undefined) {
          streams.stderr(`error: ${p.error}\n`);
        }
      }
    }
  }

  if (failedPasses.length > 0) {
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
}
