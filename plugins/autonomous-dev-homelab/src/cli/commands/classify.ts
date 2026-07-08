/**
 * `autonomous-dev-homelab inventory classify` command handler (issue #28).
 *
 * Runs the data-driven RoleClassifier over all `kind="service"` entities in
 * the inventory graph and annotates each matched entity with
 * `attributes.role` + `attributes.role_confidence`.
 *
 * Usage:
 *   homelab inventory classify [--json]
 *
 * - `--json`: emits a machine-readable JSON summary.
 *
 * Degrades gracefully: classification errors are caught and reported; the
 * command exits EXIT_OK on success, EXIT_USAGE if the graph store has no
 * service entities.
 *
 * Dynamic-first (invariant #62): classification is entirely data-driven via
 * SERVICE_ROLE_CATALOG. No homelab-specific service names appear here.
 */

import type { RoleClassifier, ClassificationSummary } from '../../discovery/role-catalog.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface ClassifyArgs {
  /** Emit machine-readable JSON instead of human-readable output. */
  json?: boolean;
}

export interface ClassifyDeps {
  roleClassifier: RoleClassifier;
  streams?: OutputStreams;
}

/**
 * Run the role classifier and optionally emit a summary.
 *
 * @param args - CLI arguments.
 * @param deps - Injected dependencies (testable).
 * @returns Exit code.
 */
export async function runClassify(args: ClassifyArgs, deps: ClassifyDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  let summary: ClassificationSummary;
  try {
    summary = await deps.roleClassifier.classify();
  } catch (err) {
    printError(`classify failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (summary.total === 0) {
    if (jsonMode) {
      printJson(
        { total: 0, classified: 0, unclassified: 0, byRole: {} },
        streams,
      );
    } else {
      streams.stdout(
        'no service entities in graph; run `inventory enumerate` first.\n',
      );
    }
    return EXIT_USAGE;
  }

  if (jsonMode) {
    printJson(
      {
        total: summary.total,
        classified: summary.classified,
        unclassified: summary.unclassified,
        by_role: summary.byRole,
      },
      streams,
    );
  } else {
    streams.stdout(
      `Classified ${summary.classified}/${summary.total} services.\n`,
    );
    if (summary.classified > 0) {
      for (const [role, count] of Object.entries(summary.byRole).sort()) {
        streams.stdout(`  ${role}: ${count}\n`);
      }
    }
    if (summary.unclassified > 0) {
      streams.stdout(
        `  (${summary.unclassified} service${summary.unclassified === 1 ? '' : 's'} matched no role pattern — retained as generic services)\n`,
      );
    }
  }

  return EXIT_OK;
}
