/**
 * `homelab observability onboard` command. Implements GitHub issue #41.
 *
 * Runs the ObservabilityOnboarder across all service entities (or a single
 * entity when `--entity <id>` is supplied) and prints an OnboardingReport
 * per entity to stdout — either as a human-readable table or `--json`.
 *
 * Endpoint discovery: purely generic (invariant #62):
 *   - Prometheus endpoint: graph entities with role=monitoring/observability,
 *     image contains "prometheus".
 *   - Logs (Loki/OpenSearch): via LogsService (issue #38).
 *   - Grafana dashboards: via GrafanaRegistry (issue #39).
 *
 * All three channels are independent: a failure in one never aborts the
 * others. Missing endpoints → channel status `unknown` (no gap emitted).
 *
 * Exit codes:
 *   0  success (including all-unknown or no services found)
 *   1  usage error (--entity not found in graph)
 */

import { Command } from 'commander';
import {
  ObservabilityOnboarder,
  FetchPrometheusHttpSource,
  type ObservabilityOnboarderOptions,
  type OnboardingReport,
} from '../../observability/onboarding.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import type { LogsService } from '../../observability/logs.js';
import type { GrafanaRegistry } from '../../observability/grafana.js';
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

export interface ObservabilityCommandDeps {
  streams?: OutputStreams;
  /**
   * Graph store used to discover Prometheus endpoint and list service entities.
   * When absent, the command cannot list all services (requires --entity).
   */
  graphStore?: GraphStore;
  /**
   * Pre-built LogsService (issue #38). Tests inject a stub-backed instance.
   */
  logsService?: LogsService;
  /**
   * Pre-built GrafanaRegistry (issue #39). Tests inject a stub-backed instance.
   */
  grafanaRegistry?: GrafanaRegistry;
  /**
   * Explicit Prometheus base URL override. Skips graph discovery for metrics.
   */
  prometheusEndpointUrl?: string;
  /**
   * Platform id for emitted observations. Defaults to `"observability"`.
   */
  platformId?: string;
}

export interface ObservabilityCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the `observability` command group and wire it to the provided deps.
 *
 * @param deps - Runtime dependencies (graph store, services, streams).
 * @returns Commander command + exit-code accessor.
 */
export function buildObservabilityCommand(
  deps: ObservabilityCommandDeps,
): ObservabilityCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('observability').description(
    'Observability onboarding: check and report observability coverage for services.',
  );

  cmd
    .command('onboard')
    .description(
      'Check metrics, logs, and dashboards coverage for service entities (issue #41).',
    )
    .option('--entity <id>', 'onboard only this graph entity id')
    .option('--json', 'emit JSON array instead of a table')
    .action(async (cmdOpts: { entity?: string; json?: boolean }) => {
      lastExit = await runObservabilityOnboard(cmdOpts, deps, streams);
    });

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

async function runObservabilityOnboard(
  opts: { entity?: string; json?: boolean },
  deps: ObservabilityCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const onboarderOpts: ObservabilityOnboarderOptions = {
    graphStore: deps.graphStore,
    prometheusHttp: new FetchPrometheusHttpSource(),
    prometheusEndpointUrl: deps.prometheusEndpointUrl,
    logsService: deps.logsService,
    grafanaRegistry: deps.grafanaRegistry,
    platformId: deps.platformId,
  };
  const onboarder = new ObservabilityOnboarder(onboarderOpts);

  let reports: OnboardingReport[];

  if (opts.entity !== undefined) {
    // Single-entity mode.
    if (deps.graphStore === undefined) {
      printError(
        'cannot resolve entity: no graph store available',
        streams,
      );
      return EXIT_USAGE;
    }

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

    const report = await onboarder.onboard(entity);
    reports = [report];
  } else {
    // All-entities mode.
    reports = await onboarder.onboardAll();
  }

  if (opts.json === true) {
    printJson(reports, streams);
    return EXIT_OK;
  }

  if (reports.length === 0) {
    streams.stdout('no service entities found to onboard\n');
    return EXIT_OK;
  }

  // Human-readable: one row per entity per channel.
  const rows: Record<string, string>[] = [];
  for (const report of reports) {
    for (const ch of report.channels) {
      rows.push({
        entity: report.entityName,
        channel: ch.channel,
        status: ch.status,
        detail: ch.detail !== undefined
          ? (ch.detail.length > 100 ? `${ch.detail.slice(0, 97)}...` : ch.detail)
          : '',
      });
    }
  }

  printTable(rows, ['entity', 'channel', 'status', 'detail'], streams);

  // Summary line.
  const totalGaps = reports.reduce(
    (acc, r) => acc + r.channels.filter((c) => c.status === 'gap').length,
    0,
  );
  const totalObservations = reports.reduce((acc, r) => acc + r.observations.length, 0);
  streams.stdout(
    `\n${reports.length} entities checked; ${totalGaps} gaps found; ${totalObservations} observations emitted\n`,
  );

  return EXIT_OK;
}
