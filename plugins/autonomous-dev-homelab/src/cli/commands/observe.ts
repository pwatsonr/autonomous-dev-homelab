/**
 * `homelab observe ...` command group. Implements SPEC-002-1-04.
 *
 * Subcommands:
 *   observe scan    [--platform <id>] [--dry-run] [--json]
 *   observe list    [--since <ISO|duration>] [--platform <id>]
 *                   [--severity P0|P1|P2] [--json]
 *   observe promote <observation-id> [--override-type bug|infra|hotfix]
 *
 * Exit codes:
 *   0  success
 *   1  bad input (unknown --severity, malformed --since, missing id)
 *   1  promotion failure (intake CLI absent or rejects)
 */

import { Command } from 'commander';
import type { ObservationCollector } from '../../observation/collector.js';
import type { ObservationStore } from '../../observation/persistence.js';
import type { ObservationPromoter } from '../../observation/promoter.js';
import type { Observation, RequestType } from '../../observation/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  printTable,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

export interface ObserveCommandDeps {
  collector: ObservationCollector;
  store: ObservationStore;
  promoter: ObservationPromoter;
  streams?: OutputStreams;
  /** Test seam; defaults to `() => Date.now()`. */
  now?: () => number;
}

export interface ObserveCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

const VALID_SEVERITIES = new Set(['P0', 'P1', 'P2']);
const VALID_REQUEST_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'bug',
  'infra',
  'hotfix',
]);

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

/**
 * Parse a `--since` value: ISO timestamp OR a short duration like
 * `30m` / `1h` / `24h` / `7d`. Returns a `Date`, or null on invalid.
 */
export function parseSince(value: string, now: number): Date | null {
  const m = DURATION_RE.exec(value);
  if (m) {
    const n = Number.parseInt(m[1] ?? '0', 10);
    const unit = m[2];
    const factor =
      unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now - n * factor);
  }
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

export function buildObserveCommand(deps: ObserveCommandDeps): ObserveCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const now = deps.now ?? ((): number => Date.now());
  let lastExit = EXIT_OK;

  const cmd = new Command('observe').description(
    'Run probes, list observations, or manually promote one to autonomous-dev intake.',
  );

  cmd
    .command('scan')
    .description('Run probes immediately (skipping the scheduled cadence).')
    .option('--platform <id>', 'restrict to a single inventory platform id')
    .option('--dry-run', 'run probes but do NOT persist or promote', false)
    .option('--json', 'emit JSON to stdout')
    .action(
      async (cmdOpts: { platform?: string; dryRun?: boolean; json?: boolean }) => {
        lastExit = await runObserveScan(cmdOpts, deps.collector, streams);
      },
    );

  cmd
    .command('list')
    .description('Print persisted observations (newest first).')
    .option('--since <iso|duration>', 'lower bound: ISO timestamp or shorthand (30m, 1h, 7d)')
    .option('--platform <id>', 'filter by platform id')
    .option('--severity <level>', 'filter by severity (P0|P1|P2)')
    .option('--json', 'emit JSON array on stdout')
    .action(
      async (cmdOpts: {
        since?: string;
        platform?: string;
        severity?: string;
        json?: boolean;
      }) => {
        lastExit = await runObserveList(cmdOpts, deps.store, streams, now);
      },
    );

  cmd
    .command('promote')
    .description('Manually promote an observation to autonomous-dev intake.')
    .argument('<observation-id>', 'observation id to promote')
    .option('--override-type <type>', 'override the catalog-derived request type (bug|infra|hotfix)')
    .action(
      async (
        observationId: string,
        cmdOpts: { overrideType?: string },
      ) => {
        lastExit = await runObservePromote(
          observationId,
          cmdOpts,
          deps.store,
          deps.promoter,
          streams,
        );
      },
    );

  return { command: cmd, lastExitCode: () => lastExit };
}

async function runObserveScan(
  opts: { platform?: string; dryRun?: boolean; json?: boolean },
  collector: ObservationCollector,
  streams: OutputStreams,
): Promise<number> {
  const filter = opts.platform !== undefined ? { platformId: opts.platform } : {};
  const fresh = await collector.runAll(filter, { dryRun: opts.dryRun === true });
  if (opts.json === true) {
    printJson(
      { count: fresh.length, dryRun: opts.dryRun === true, observations: fresh },
      streams,
    );
  } else {
    const dryNote = opts.dryRun === true ? ' (dry-run; not persisted)' : '';
    streams.stdout(`scan complete: ${fresh.length} fresh observation(s)${dryNote}\n`);
    for (const obs of fresh) {
      streams.stdout(
        `  ${obs.severity} ${obs.pattern} ${obs.platform} ${obs.resource}\n`,
      );
    }
  }
  return EXIT_OK;
}

async function runObserveList(
  opts: { since?: string; platform?: string; severity?: string; json?: boolean },
  store: ObservationStore,
  streams: OutputStreams,
  now: () => number,
): Promise<number> {
  if (opts.severity !== undefined && !VALID_SEVERITIES.has(opts.severity)) {
    printError(
      `invalid --severity ${opts.severity}; expected one of P0, P1, P2`,
      streams,
    );
    return EXIT_USAGE;
  }
  const filter: Parameters<ObservationStore['list']>[0] = {};
  if (opts.platform !== undefined) filter.platform = opts.platform;
  if (opts.severity !== undefined) filter.severity = opts.severity;
  if (opts.since !== undefined) {
    const since = parseSince(opts.since, now());
    if (since === null) {
      printError(
        `invalid --since ${opts.since}; expected ISO timestamp or duration like 30m/1h/7d`,
        streams,
      );
      return EXIT_USAGE;
    }
    filter.since = since;
  }
  const observations = await store.list(filter);
  if (opts.json === true) {
    printJson(observations, streams);
    return EXIT_OK;
  }
  if (observations.length === 0) {
    streams.stdout('no observations match\n');
    return EXIT_OK;
  }
  printTable(
    observations.map((o) => ({
      severity: o.severity,
      pattern: o.pattern,
      platform: o.platform,
      resource: o.resource,
      discovered_at: o.discovered_at,
      id: o.id,
    })),
    ['severity', 'pattern', 'platform', 'resource', 'discovered_at', 'id'],
    streams,
  );
  return EXIT_OK;
}

async function runObservePromote(
  observationId: string,
  opts: { overrideType?: string },
  store: ObservationStore,
  promoter: ObservationPromoter,
  streams: OutputStreams,
): Promise<number> {
  if (
    opts.overrideType !== undefined &&
    !VALID_REQUEST_TYPES.has(opts.overrideType as RequestType)
  ) {
    printError(
      `invalid --override-type ${opts.overrideType}; expected one of bug, infra, hotfix`,
      streams,
    );
    return EXIT_USAGE;
  }
  let obs: Observation;
  try {
    obs = await store.load(observationId);
  } catch {
    printError(`observation not found: ${observationId}`, streams);
    return EXIT_USAGE;
  }
  const promoteOpts: Parameters<ObservationPromoter['promote']>[1] = {};
  if (opts.overrideType !== undefined) {
    promoteOpts.overrideType = opts.overrideType as RequestType;
    streams.stderr(
      `WARNING: --override-type bypasses the FAULT_CATALOG mapping for ${observationId}\n`,
    );
  }
  try {
    await promoter.promote(obs, promoteOpts);
  } catch (err) {
    printError(`promotion failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }
  streams.stdout(`promoted ${observationId}\n`);
  return EXIT_OK;
}
