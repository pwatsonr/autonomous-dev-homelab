/**
 * `homelab health score` command.
 *
 * Scores all (or one) graph entity and prints a health summary.
 * Uses the generic `HealthScorer` — no hard-coded service names
 * (invariant #62). Writes `health_score` / `health_grade` back to the graph
 * so the portal can read them per-entity without a separate compute step.
 *
 * Subcommands:
 *   health score                  — score all entities, print table
 *   health score --entity <id>    — score a single entity, print detail
 *   health score --json           — emit JSON
 *
 * Exit codes:
 *   0  success (including no entities)
 *   1  usage error (entity not found, graph unavailable)
 */

import { Command } from 'commander';
import { HealthScorer, type SloSpec } from '../../observability/health.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import type { ObservationStore } from '../../observation/persistence.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  printTable,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCommandDeps {
  streams?: OutputStreams;
  /** Graph store backed by `inventory-graph.yaml`. */
  graphStore: GraphStore;
  /** Observation store backed by the observations directory. */
  observationStore: ObservationStore;
  /**
   * Per-entity SLO specs (keyed by entity id). Optional; when omitted the
   * scorer uses its built-in defaults. Invariant #62: indexed by entity id,
   * never by hard-coded service names.
   */
  sloSpecs?: Map<string, SloSpec>;
  /**
   * Test seam: override the reference timestamp. Defaults to `Date.now()`.
   * When provided, the scorer's pure path uses this value and never calls
   * `Date.now()` internally.
   */
  now?: () => number;
}

export interface HealthCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the `health` command group and wire it to the provided deps.
 *
 * @param deps - Runtime dependencies.
 * @returns Commander command + exit-code accessor.
 */
export function buildHealthCommand(deps: HealthCommandDeps): HealthCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('health').description(
    'Compute and display rolling health scores for inventory entities (issue #40).',
  );

  cmd
    .command('score')
    .description(
      'Score all graph entities and write health_score/health_grade back to the graph.',
    )
    .option('--entity <id>', 'score only this entity (by graph entity id)')
    .option('--json', 'emit JSON instead of a table')
    .action(async (cmdOpts: { entity?: string; json?: boolean }) => {
      lastExit = await runHealthScore(cmdOpts, deps, streams);
    });

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

async function runHealthScore(
  opts: { entity?: string; json?: boolean },
  deps: HealthCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const now = deps.now !== undefined ? deps.now() : Date.now();

  const scorer = new HealthScorer({
    graphStore: deps.graphStore,
    observationStore: deps.observationStore,
    sloSpecs: deps.sloSpecs,
  });

  // Score all entities (writes attributes back to the graph).
  let scored: number;
  try {
    scored = await scorer.scoreAll(now);
  } catch (err) {
    printError(`health scoring failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  // If a specific entity was requested, re-read it from the graph and report.
  if (opts.entity !== undefined) {
    let entity;
    try {
      entity = await deps.graphStore.getEntity(opts.entity);
    } catch (err) {
      printError(`graph store error: ${(err as Error).message}`, streams);
      return EXIT_USAGE;
    }
    if (entity === null) {
      printError(`entity not found: ${opts.entity}`, streams);
      return EXIT_USAGE;
    }

    const score = entity.attributes['health_score'];
    const grade = entity.attributes['health_grade'];

    if (opts.json === true) {
      printJson(
        { id: entity.id, kind: entity.kind, name: entity.name, score, grade },
        streams,
      );
    } else {
      streams.stdout(
        `${entity.kind}/${entity.name} (${entity.id}): score=${String(score)} grade=${String(grade)}\n`,
      );
    }
    return EXIT_OK;
  }

  // Otherwise read all entities and print a summary table.
  let allEntities;
  try {
    const doc = await deps.graphStore.all();
    allEntities = doc.entities;
  } catch (err) {
    printError(`graph store error: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (allEntities.length === 0) {
    streams.stdout('no entities in graph\n');
    return EXIT_OK;
  }

  const rows: Record<string, string>[] = allEntities.map((e) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    status: e.status,
    health_score: e.attributes['health_score'] !== undefined
      ? String(e.attributes['health_score'])
      : 'n/a',
    health_grade: e.attributes['health_grade'] !== undefined
      ? String(e.attributes['health_grade'])
      : 'n/a',
  }));

  if (opts.json === true) {
    printJson({ scored, entities: rows }, streams);
  } else {
    streams.stdout(`Scored ${scored} entity/entities.\n`);
    printTable(rows, ['id', 'kind', 'name', 'status', 'health_score', 'health_grade'], streams);
  }

  return EXIT_OK;
}
