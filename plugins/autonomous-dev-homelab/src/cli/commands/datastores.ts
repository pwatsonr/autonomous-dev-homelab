/**
 * `autonomous-dev-homelab inventory datastores` command handler (issue #42).
 *
 * Runs the DatastoreProbe over all `kind='service'|'container'` entities with
 * `attributes.role='database'|'cache'` (or matching a registered engine probe
 * image signal) and prints a structured summary of discovered datastores.
 *
 * Usage:
 *   homelab inventory datastores [--json]
 *
 * - `--json`: emit machine-readable JSON output.
 *
 * Design (dynamic-first invariant, issue #62):
 * - No hard-coded datastore instance names in this command.
 * - Datastores are discovered generically via role tags + image signals.
 * - Summary prints engine, version, health, child count per datastore.
 *
 * Degrades gracefully: if no datastore candidates are found, exits with
 * EXIT_USAGE and a helpful message; never crashes on individual entity errors.
 */

import type { DatastoreProbe, DatastoreProbeResult } from '../../discovery/datastore-probe.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface DatastoresArgs {
  /** Emit machine-readable JSON instead of human-readable output. */
  json?: boolean;
}

export interface DatastoresDeps {
  datastoreProbe: DatastoreProbe;
  streams?: OutputStreams;
}

/**
 * Run the datastore discovery probe and print a summary.
 *
 * @param args - CLI arguments.
 * @param deps - Injected dependencies (testable).
 * @returns Exit code.
 */
export async function runDatastores(args: DatastoresArgs, deps: DatastoresDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  let result: DatastoreProbeResult;
  try {
    // Run without a live connection: structures are read from the graph;
    // health introspection requires a connection (injected by the CLI
    // bootstrap when available). For this summary command, we discover
    // from the graph — callers who need live introspection inject a
    // connection via DatastoreProbe constructor options.
    result = await deps.datastoreProbe.probe();
  } catch (err) {
    printError(`datastore probe failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  if (result.discovered === 0) {
    if (jsonMode) {
      printJson({ discovered: 0, introspected: 0, skipped: 0, datastores: [] }, streams);
    } else {
      streams.stdout(
        'no datastore entities found; run `inventory enumerate` then `inventory classify` first.\n',
      );
    }
    return EXIT_USAGE;
  }

  if (jsonMode) {
    printJson(
      {
        discovered: result.discovered,
        introspected: result.introspected,
        skipped: result.skipped,
        datastores: result.results.map((r) => ({
          id: r.datastoreEntity.id,
          name: r.datastoreEntity.name,
          engine: r.datastoreEntity.attributes['engine'] ?? 'unknown',
          version: r.datastoreEntity.attributes['version'] ?? 'unknown',
          health: r.datastoreEntity.attributes['health'] ?? 'unknown',
          databases: r.children.map((c) => ({
            name: c.name,
            size_bytes: c.attributes['size_bytes'] ?? -1,
            count: c.attributes['count'] ?? -1,
          })),
        })),
      },
      streams,
    );
  } else {
    streams.stdout(`Found ${result.discovered} datastore(s):\n\n`);
    for (const r of result.results) {
      const attrs = r.datastoreEntity.attributes;
      const engine = typeof attrs['engine'] === 'string' ? attrs['engine'] : 'unknown';
      const version = typeof attrs['version'] === 'string' ? attrs['version'] : 'unknown';
      const health = typeof attrs['health'] === 'string' ? attrs['health'] : 'unknown';
      streams.stdout(
        `  ${r.datastoreEntity.name}  engine=${engine}  version=${version}  health=${health}` +
        `  databases=${r.children.length}\n`,
      );
      for (const child of r.children) {
        const size = child.attributes['size_bytes'];
        const count = child.attributes['count'];
        streams.stdout(
          `    - ${child.name}` +
          (size !== undefined && size !== -1 ? `  size=${String(size)}B` : '') +
          (count !== undefined && count !== -1 ? `  count=${String(count)}` : '') +
          '\n',
        );
      }
    }
    streams.stdout(
      `\nTotal: ${result.discovered} discovered, ${result.introspected} introspected, ${result.skipped} skipped.\n`,
    );
  }

  return EXIT_OK;
}
