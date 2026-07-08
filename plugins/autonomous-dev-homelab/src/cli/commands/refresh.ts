/**
 * `autonomous-dev-homelab inventory refresh` command handler.
 *
 * Implements issue #31 §"CLI affordance": runs one incremental refresh
 * sweep — enumerating all (or a subset of) platforms, reconciling
 * staleness/gone transitions, and emitting drift observations — then
 * prints a human-readable or JSON summary.
 *
 * Usage:
 *   homelab inventory refresh [--platform <id>] [--json]
 *
 * Exit codes mirror `inventory enumerate`:
 *  - EXIT_OK (0):       sweep completed; at least one platform succeeded.
 *  - EXIT_PARTIAL (3):  some platforms failed to enumerate.
 *  - EXIT_USAGE (1):    inventory empty, or all platforms failed.
 */

import type { RefreshEngine, SweepResult } from '../../discovery/refresh.js';
import { EXIT_OK, EXIT_USAGE, EXIT_PARTIAL } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface RefreshArgs {
  /** Optional platform ID filter; when set only that platform is swept. */
  platform?: string;
  /** Emit machine-readable JSON instead of human-readable output. */
  json?: boolean;
}

export interface RefreshDeps {
  refreshEngine: RefreshEngine;
  streams?: OutputStreams;
}

/**
 * Run one inventory refresh sweep and report the results.
 *
 * @param args - CLI arguments.
 * @param deps - Injected dependencies (testable).
 * @returns Exit code.
 */
export async function runRefresh(args: RefreshArgs, deps: RefreshDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  let result: SweepResult;
  try {
    result = await deps.refreshEngine.sweep(
      args.platform !== undefined ? { platformFilter: [args.platform] } : {},
    );
  } catch (err) {
    printError(`refresh sweep failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (jsonMode) {
    printJson(
      {
        sweep_at: result.sweepAt,
        entities_upserted: result.entitiesUpserted,
        edges_upserted: result.edgesUpserted,
        platforms_failed: result.platformsFailed,
        marked_stale: result.markedStale,
        marked_gone: result.markedGone,
        drift_events: result.driftEvents.length,
        observations_emitted: result.observationsEmitted,
        drift: result.driftEvents.map((e) => {
          switch (e.kind) {
            case 'entity_added':
              return { kind: e.kind, entity_id: e.entity.id, entity_kind: e.entity.kind, name: e.entity.name };
            case 'entity_gone':
              return { kind: e.kind, entity_id: e.entity.id, entity_kind: e.entity.kind, name: e.entity.name };
            case 'replica_mismatch':
              return {
                kind: e.kind,
                entity_id: e.entity.id,
                entity_kind: e.entity.kind,
                name: e.entity.name,
                replicas_running: e.replicasRunning,
                replicas_desired: e.replicasDesired,
              };
            case 'image_changed':
              return {
                kind: e.kind,
                entity_id: e.entity.id,
                entity_kind: e.entity.kind,
                name: e.entity.name,
                previous_image: e.previousImage,
                current_image: e.currentImage,
              };
          }
        }),
      },
      streams,
    );
  } else {
    streams.stdout(`Refresh sweep at ${result.sweepAt}\n`);
    streams.stdout(
      `  Upserted:  ${result.entitiesUpserted} entities, ${result.edgesUpserted} edges\n`,
    );
    streams.stdout(
      `  Lifecycle: ${result.markedStale} stale, ${result.markedGone} gone\n`,
    );
    streams.stdout(
      `  Drift:     ${result.driftEvents.length} events, ${result.observationsEmitted} observations emitted\n`,
    );
    if (result.platformsFailed > 0) {
      streams.stderr(
        `  WARNING:   ${result.platformsFailed} platform(s) failed to enumerate\n`,
      );
    }
    for (const event of result.driftEvents) {
      switch (event.kind) {
        case 'entity_added':
          streams.stdout(
            `  + ADDED    ${event.entity.kind}/${event.entity.name} (${event.entity.id})\n`,
          );
          break;
        case 'entity_gone':
          streams.stdout(
            `  - GONE     ${event.entity.kind}/${event.entity.name} (${event.entity.id})\n`,
          );
          break;
        case 'replica_mismatch':
          streams.stdout(
            `  ! REPLICAS ${event.entity.kind}/${event.entity.name}: ` +
            `${event.replicasRunning}/${event.replicasDesired} running\n`,
          );
          break;
        case 'image_changed':
          streams.stdout(
            `  ~ IMAGE    ${event.entity.kind}/${event.entity.name}: ` +
            `${event.previousImage} → ${event.currentImage}\n`,
          );
          break;
      }
    }
  }

  if (result.entitiesUpserted === 0 && result.platformsFailed > 0) {
    // Every reachable platform had nothing to report; likely inventory is empty.
    return EXIT_USAGE;
  }
  if (result.platformsFailed > 0) {
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
}
