/**
 * `homelab grafana dashboards` command.
 * Implements the optional CLI from GitHub issue #39.
 *
 * Lists all dashboards in the Grafana registry, optionally filtered to those
 * that match a specific graph entity id (`--entity <id>`). Outputs a human-
 * readable table or `--json` for scripting.
 *
 * The command is wired to a real `FetchGrafanaHttpSource` production HTTP
 * source and discovers the Grafana endpoint generically from the inventory
 * graph (invariant #62). `--endpoint` allows an explicit override for
 * homelab setups where the graph is not yet populated.
 *
 * Exit codes:
 *   0  success (including empty result)
 *   1  usage error (unknown --entity, missing --endpoint when no graph)
 */

import { Command } from 'commander';
import {
  GrafanaRegistry,
  type GrafanaHttpSource,
  type DashboardLink,
  type GrafanaDashboardSearchResult,
} from '../../observability/grafana.js';
import type { GraphStore } from '../../discovery/graph-store.js';
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

export interface GrafanaCommandDeps {
  streams?: OutputStreams;
  /**
   * Injected HTTP source. Production passes `FetchGrafanaHttpSource`;
   * tests pass a stub. Required so the CLI is never backed by a bare stub.
   */
  http: GrafanaHttpSource;
  /**
   * Graph store used for generic Grafana endpoint + entity discovery.
   * When absent, `--endpoint` must be supplied on every invocation.
   */
  graphStore?: GraphStore;
  /**
   * Optional process environment override (for GRAFANA_API_TOKEN reading).
   * Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface GrafanaCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the `grafana` command group and wire it to the provided deps.
 *
 * @param deps - Runtime dependencies (HTTP source, graph store, streams).
 * @returns Commander command + exit-code accessor.
 */
export function buildGrafanaCommand(deps: GrafanaCommandDeps): GrafanaCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('grafana').description(
    'Inspect Grafana dashboards and resolve deep-links for inventory entities.',
  );

  cmd
    .command('dashboards')
    .description(
      'List Grafana dashboards, optionally matched to an inventory entity.',
    )
    .option('--entity <id>', 'resolve dashboards for this graph entity id')
    .option(
      '--endpoint <url>',
      'explicit Grafana base URL (overrides graph discovery)',
    )
    .option('--json', 'emit JSON array instead of a table')
    .action(
      async (cmdOpts: { entity?: string; endpoint?: string; json?: boolean }) => {
        lastExit = await runGrafanaDashboards(cmdOpts, deps, streams);
      },
    );

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function runGrafanaDashboards(
  opts: { entity?: string; endpoint?: string; json?: boolean },
  deps: GrafanaCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const registry = new GrafanaRegistry({
    http: deps.http,
    graphStore: deps.graphStore,
    endpointUrl: opts.endpoint,
    env: deps.env,
  });

  // If an entity id is provided, resolve dashboards for that entity.
  if (opts.entity !== undefined) {
    return runEntityDashboards(opts.entity, registry, opts.json === true, deps, streams);
  }

  // Otherwise list all dashboards.
  return runListAll(registry, opts.json === true, streams);
}

async function runListAll(
  registry: GrafanaRegistry,
  json: boolean,
  streams: OutputStreams,
): Promise<number> {
  const dashboards = await registry.fetchDashboards();

  if (json) {
    printJson(dashboards, streams);
    return EXIT_OK;
  }

  if (dashboards.length === 0) {
    streams.stdout('no dashboards found (Grafana unreachable, token absent, or empty)\n');
    return EXIT_OK;
  }

  printTable(
    dashboards.map((d: GrafanaDashboardSearchResult) => ({
      uid: d.uid,
      title: d.title,
      folder: d.folderTitle ?? '',
      tags: (d.tags ?? []).join(','),
      url: d.url,
    })),
    ['uid', 'title', 'folder', 'tags', 'url'],
    streams,
  );
  return EXIT_OK;
}

async function runEntityDashboards(
  entityId: string,
  registry: GrafanaRegistry,
  json: boolean,
  deps: GrafanaCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  // Look up the entity from the graph store.
  if (deps.graphStore === undefined) {
    printError(
      'cannot resolve entity dashboards: no graph store available (supply --endpoint to list all)',
      streams,
    );
    return EXIT_USAGE;
  }

  let entity;
  try {
    entity = await deps.graphStore.getEntity(entityId);
  } catch (err) {
    printError(`graph store error: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (entity === null) {
    printError(`entity not found: ${entityId}`, streams);
    return EXIT_USAGE;
  }

  const links = await registry.resolveDashboardsForEntity(entity);

  if (json) {
    printJson(links, streams);
    return EXIT_OK;
  }

  if (links.length === 0) {
    streams.stdout(`no dashboards matched entity '${entityId}'\n`);
    return EXIT_OK;
  }

  printTable(
    links.map((l: DashboardLink) => ({
      uid: l.uid,
      title: l.title,
      folder: l.folder,
      match: l.matchKind,
      deepLink: l.deepLink,
    })),
    ['uid', 'title', 'folder', 'match', 'deepLink'],
    streams,
  );
  return EXIT_OK;
}
