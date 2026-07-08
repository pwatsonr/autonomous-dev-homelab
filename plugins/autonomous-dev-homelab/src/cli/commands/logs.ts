/**
 * `homelab logs` command. Implements issue #38.
 *
 * Queries service logs from Loki and/or OpenSearch via `LogsService` and
 * prints normalized `LogEntry` records to stdout.
 *
 * Usage:
 *   homelab logs [<resource>] [--service <s>] [--since <duration|ISO>]
 *                [--until <ISO>] [--limit <n>] [--filter <text>] [--json]
 *
 * Endpoint discovery: generic from the inventory graph (role=observability/
 * monitoring/logging; image contains loki/opensearch/elasticsearch).
 * Config override via `--loki-url` / `--opensearch-url`.
 *
 * READ-ONLY: no write, ingest, or delete operations.
 * Graceful: when all backends are unreachable, exits 0 with an empty list
 * (or a WARN on stderr).
 */

import { Command } from 'commander';
import { GraphStore } from '../../discovery/graph-store.js';
import {
  LogsService,
  FetchLogsHttpSource,
  type LogsServiceOptions,
  type LogQuery,
  type LogEntry,
} from '../../observability/logs.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  printTable,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

export interface LogsCommandDeps {
  streams?: OutputStreams;
  /**
   * Override for tests: supply a pre-built `LogsService` instead of
   * letting the command construct one.
   */
  logsService?: LogsService;
  /**
   * Path to the inventory graph file. Used only when `logsService` is not
   * injected. Defaults to `<dataDir>/inventory-graph.yaml`.
   */
  graphPath?: string;
}

export interface LogsCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/**
 * Build the `homelab logs` command and wire it to `LogsService`.
 *
 * @param deps - Dependencies (injectable for tests).
 * @returns Commander `Command` and a `lastExitCode()` accessor.
 */
export function buildLogsCommand(deps: LogsCommandDeps = {}): LogsCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('logs')
    .description(
      'Query service logs from Loki and/or OpenSearch (read-only; issue #38).',
    )
    .argument('[resource]', 'filter by resource (container name, pod, host, etc.)')
    .option('--service <name>', 'filter by service name')
    .option('--since <duration|ISO>', 'lower bound: duration like 30m/1h/7d or ISO timestamp')
    .option('--until <ISO>', 'upper bound: ISO timestamp (default: now)')
    .option('--limit <n>', 'maximum number of log entries (default: 100, max: 1000)', '100')
    .option('--filter <text>', 'free-text substring/query filter')
    .option('--json', 'emit JSON array on stdout')
    .option('--loki-url <url>', 'override Loki base URL (skips graph discovery)')
    .option('--opensearch-url <url>', 'override OpenSearch base URL (skips graph discovery)')
    .option('--data-dir <path>', 'data directory (for graph discovery)')
    .action(
      async (
        resource: string | undefined,
        cmdOpts: {
          service?: string;
          since?: string;
          until?: string;
          limit?: string;
          filter?: string;
          json?: boolean;
          lokiUrl?: string;
          opensearchUrl?: string;
          dataDir?: string;
        },
      ) => {
        lastExit = await runLogs(resource, cmdOpts, deps, streams);
      },
    );

  return { command: cmd, lastExitCode: (): number => lastExit };
}

async function runLogs(
  resource: string | undefined,
  opts: {
    service?: string;
    since?: string;
    until?: string;
    limit?: string;
    filter?: string;
    json?: boolean;
    lokiUrl?: string;
    opensearchUrl?: string;
    dataDir?: string;
  },
  deps: LogsCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  // Parse and validate limit.
  const limitRaw = Number.parseInt(opts.limit ?? '100', 10);
  if (Number.isNaN(limitRaw) || limitRaw < 1) {
    printError(`invalid --limit value: ${opts.limit ?? ''}`, streams);
    return EXIT_USAGE;
  }

  const q: LogQuery = {
    resource: resource !== undefined && resource !== '' ? resource : undefined,
    service: opts.service,
    since: opts.since,
    until: opts.until,
    limit: limitRaw,
    filter: opts.filter,
  };

  // Resolve or construct the LogsService.
  let svc: LogsService;
  if (deps.logsService !== undefined) {
    svc = deps.logsService;
  } else {
    const svcOpts: LogsServiceOptions = {
      http: new FetchLogsHttpSource(),
    };

    // Apply URL overrides from flags.
    const endpointUrls: Record<string, string> = {};
    if (typeof opts.lokiUrl === 'string' && opts.lokiUrl !== '') {
      endpointUrls['loki'] = opts.lokiUrl;
    }
    if (typeof opts.opensearchUrl === 'string' && opts.opensearchUrl !== '') {
      endpointUrls['opensearch'] = opts.opensearchUrl;
    }
    if (Object.keys(endpointUrls).length > 0) {
      svcOpts.endpointUrls = endpointUrls;
    }

    // Wire the graph store for generic discovery when no override given.
    const hasOverrides =
      Object.keys(endpointUrls).length === 2 ||
      (endpointUrls['loki'] !== undefined && endpointUrls['opensearch'] !== undefined);
    if (!hasOverrides) {
      const dataDir = opts.dataDir;
      if (typeof dataDir === 'string' && dataDir !== '') {
        const graphPath = deps.graphPath ?? `${dataDir}/inventory-graph.yaml`;
        svcOpts.graphStore = new GraphStore(graphPath);
      }
    }

    svc = new LogsService(svcOpts);
  }

  let result: Awaited<ReturnType<LogsService['query']>>;
  try {
    result = await svc.query(q);
  } catch (err) {
    printError(`logs query failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  // Warn when all backends have no endpoint.
  const allNoEndpoint = Object.values(result.backends).every((s) => s === 'no_endpoint');
  if (allNoEndpoint) {
    streams.stderr(
      'WARNING: no log backends discovered or configured; use --loki-url / --opensearch-url or run `inventory enumerate` first\n',
    );
  }

  if (opts.json === true) {
    printJson({ entries: result.entries, backends: result.backends }, streams);
    return EXIT_OK;
  }

  if (result.entries.length === 0) {
    streams.stdout('no log entries match\n');
    return EXIT_OK;
  }

  printTable(
    result.entries.map(entryToRow),
    ['timestamp', 'level', 'source', 'message'],
    streams,
  );
  return EXIT_OK;
}

/**
 * Convert a `LogEntry` to a flat string record suitable for `printTable`.
 *
 * @param entry - Normalized log entry.
 * @returns Row object with string values for each column.
 */
function entryToRow(entry: LogEntry): Record<string, string> {
  return {
    timestamp: entry.timestamp,
    level: entry.level ?? '',
    source: entry.source,
    // Truncate long messages for table display.
    message: entry.message.length > 120 ? `${entry.message.slice(0, 117)}...` : entry.message,
  };
}
