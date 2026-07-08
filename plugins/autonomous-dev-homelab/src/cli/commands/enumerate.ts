/**
 * `autonomous-dev-homelab inventory enumerate` command handler.
 *
 * Implements issue #27 §"CLI affordance": triggers a deep enumeration pass
 * over all (or a subset of) known platforms and upserts results into the
 * inventory graph. Designed to run after `discover` has fingerprinted
 * platforms.
 *
 * Usage:
 *   homelab inventory enumerate [--platform <id>] [--json]
 *
 * - Without `--platform`: enumerates every known platform.
 * - With `--platform <id>`: enumerates only the named platform.
 * - `--json`: emits a machine-readable JSON summary.
 *
 * Degrades gracefully: unreachable or unsupported platforms produce a
 * warning line (or JSON entry) and enumeration continues. The command
 * exits 0 when at least one platform succeeded, EXIT_PARTIAL (3) when
 * some failed, and EXIT_USAGE (1) when the inventory is empty or all
 * platforms failed.
 */

import type { DeepEnumerator } from '../../discovery/deep-enumerator.js';
import type { DeepEnumerationResult } from '../../discovery/deep-enumerator.js';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface EnumerateArgs {
  /** Optional platform ID filter; when provided only that platform is enumerated. */
  platform?: string;
  /** Emit machine-readable JSON instead of human-readable output. */
  json?: boolean;
}

export interface EnumerateDeps {
  deepEnumerator: DeepEnumerator;
  streams?: OutputStreams;
}

/**
 * Run a deep enumeration pass and upsert results into the graph store.
 *
 * @param args - CLI arguments.
 * @param deps - Injected dependencies (testable).
 * @returns Exit code.
 */
export async function runEnumerate(args: EnumerateArgs, deps: EnumerateDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  let result: DeepEnumerationResult;
  try {
    result = await deps.deepEnumerator.enumerate(
      args.platform !== undefined ? { platformFilter: [args.platform] } : {},
    );
  } catch (err) {
    printError(`enumeration failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (result.summaries.length === 0) {
    if (jsonMode) {
      printJson({ summaries: [], total_entities: 0, total_edges: 0 }, streams);
    } else {
      streams.stdout(
        'no platforms in inventory; run `discover --cidr <cidr>` first.\n',
      );
    }
    return EXIT_USAGE;
  }

  const succeeded = result.summaries.filter((s) => s.ok);
  const failed = result.summaries.filter((s) => !s.ok);

  if (jsonMode) {
    printJson(
      {
        summaries: result.summaries.map((s) => ({
          platform_id: s.platformId,
          platform_kind: s.platformKind,
          ok: s.ok,
          entities_upserted: s.entitiesUpserted,
          edges_upserted: s.edgesUpserted,
          ...(s.error !== undefined ? { error: s.error } : {}),
        })),
        total_entities: result.totalEntities,
        total_edges: result.totalEdges,
      },
      streams,
    );
  } else {
    for (const s of succeeded) {
      streams.stdout(
        `${s.platformId} (${s.platformKind}): ${s.entitiesUpserted} entities, ${s.edgesUpserted} edges\n`,
      );
    }
    for (const s of failed) {
      streams.stderr(
        `${s.platformId} (${s.platformKind}): FAILED — ${s.error ?? 'unknown error'}\n`,
      );
    }
    streams.stdout(
      `Enumerated ${succeeded.length}/${result.summaries.length} platforms. ` +
      `Total: ${result.totalEntities} entities, ${result.totalEdges} edges.\n`,
    );
  }

  if (succeeded.length === 0) {
    return EXIT_USAGE;
  }
  if (failed.length > 0) {
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
}
