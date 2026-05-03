/**
 * `homelab migrations status [--id <id>]` per SPEC-002-2-04.
 *
 * Prints in-flight migrations (or one specific id) with current phase,
 * status, and remaining time when in the approval-delay phase.
 */

import { Command } from 'commander';
import {
  listInFlightMigrations,
  loadMigrationState,
} from '../../migration/state-store.js';
import type { MigrationState } from '../../migration/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface MigrationsStatusView {
  migration_id: string;
  source: string;
  target: string;
  current_phase: string;
  status: string;
  remaining_seconds: number | null;
  overall: string;
}

export interface MigrationsCommandDeps {
  /** Test seam: override migration loaders. Defaults to module exports. */
  list?: () => Promise<MigrationState[]>;
  load?: (id: string) => Promise<MigrationState>;
  streams?: OutputStreams;
  /** Override clock for deterministic remaining-seconds in tests. */
  now?: () => number;
}

export interface MigrationsCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

function toView(m: MigrationState, now: number): MigrationsStatusView {
  const phase = m.phases[m.current_phase_index];
  const phaseName = phase?.name ?? 'unknown';
  const phaseStatus = phase?.status ?? 'unknown';
  let remainingSeconds: number | null = null;
  if (phase?.name === 'approval-delay' && phase.started_at !== undefined) {
    const elapsed = (now - Date.parse(phase.started_at)) / 1000;
    remainingSeconds = Math.max(0, m.approval_delay_seconds - elapsed);
  }
  return {
    migration_id: m.migration_id,
    source: m.source_platform,
    target: m.target_platform,
    current_phase: phaseName,
    status: phaseStatus,
    remaining_seconds: remainingSeconds,
    overall: m.overall_status,
  };
}

/** Pure-function entry point. */
export async function runMigrationsStatus(
  opts: { id?: string; json?: boolean },
  deps: MigrationsCommandDeps = {},
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const now = deps.now ?? ((): number => Date.now());
  const load = deps.load ?? loadMigrationState;
  const list = deps.list ?? listInFlightMigrations;

  let migrations: MigrationState[];
  try {
    migrations = opts.id !== undefined ? [await load(opts.id)] : await list();
  } catch (e) {
    const err = e as Error;
    printError(`failed to read migration state: ${err.message}`, streams);
    return EXIT_USAGE;
  }
  const view = migrations.map((m) => toView(m, now()));
  if (opts.json === true) {
    printJson(view, streams);
  } else {
    for (const v of view) {
      const remaining =
        v.remaining_seconds !== null
          ? ` | remaining=${Math.floor(v.remaining_seconds / 60)}m`
          : '';
      streams.stdout(
        `${v.migration_id}: ${v.source}->${v.target} | phase=${v.current_phase}(${v.status}) | overall=${v.overall}${remaining}\n`,
      );
    }
  }
  return EXIT_OK;
}

/** Build the `migrations` Commander subcommand. */
export function buildMigrationsCommand(deps: MigrationsCommandDeps = {}): MigrationsCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('migrations').description('Inspect homelab migration state.');

  cmd
    .command('status')
    .description('List in-flight migrations (or a specific one with --id).')
    .option('--id <id>', 'show one specific migration')
    .option('--json', 'emit JSON instead of human-readable text')
    .action(async (cmdOpts: { id?: string; json?: boolean }) => {
      lastExit = await runMigrationsStatus(
        { ...(cmdOpts.id !== undefined ? { id: cmdOpts.id } : {}), json: cmdOpts.json === true },
        { ...deps, streams },
      );
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
