/**
 * `homelab rules` command group (issue #34).
 *
 * Subcommands:
 *   rules show [--json]           — derive and print the topology descriptor
 *                                   + generated policy document
 *   rules export [--out <path>]   — write the policy document to a file
 *                                   (default: ./homelab-deploy-policy.json)
 *
 * Read-only: the command derives facts from the graph and emits a document
 * for the operator to feed to the core `deploy.policy` config. It never
 * modifies the graph or enforces rules directly (the core engine does that).
 *
 * Exit codes:
 *   0  success
 *   1  usage error (graph unreadable, output path invalid)
 *   10 internal error
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { TopologyAnalyzer, type TopologyDescriptor } from '../../rules/topology.js';
import { PolicyGenerator, type PolicyDocument } from '../../rules/policy-generator.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RulesCommandDeps {
  streams?: OutputStreams;
  /** Graph store backed by `inventory-graph.yaml`. */
  graphStore: GraphStore;
  /**
   * Optional clock override (returns ISO-8601 string). Defaults to
   * `new Date().toISOString()`. Injected by tests.
   */
  clock?: () => string;
}

export interface RulesCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Combined view returned by `rules show`. */
export interface RulesShowResult {
  topology: TopologyDescriptor;
  policy: PolicyDocument;
}

// ---------------------------------------------------------------------------
// Action handlers (exported for direct testing without Commander overhead)
// ---------------------------------------------------------------------------

/**
 * Derive and return the topology descriptor + policy document.
 *
 * Pure-ish: reads the graph, computes topology facts, generates rules.
 * No writes to disk. Returns the combined view and an exit code.
 *
 * @param opts  - Show options.
 * @param deps  - Runtime dependencies.
 * @returns Combined result and exit code.
 */
export async function runRulesShow(
  opts: { json?: boolean },
  deps: RulesCommandDeps,
): Promise<{ exitCode: number; result?: RulesShowResult }> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const analyzer = new TopologyAnalyzer(deps.graphStore, { clock: deps.clock });
  const generator = new PolicyGenerator();

  let topology: TopologyDescriptor;
  try {
    topology = await analyzer.analyze();
  } catch (err) {
    printError(`failed to read inventory graph: ${(err as Error).message}`, streams);
    return { exitCode: EXIT_USAGE };
  }

  const policy = generator.generate(topology);
  const result: RulesShowResult = { topology, policy };

  if (opts.json === true) {
    printJson(result, streams);
  } else {
    streams.stdout(`Topology descriptor (${topology.nodes.length} node(s)):\n`);
    for (const node of topology.nodes) {
      streams.stdout(
        `  ${node.kind}/${node.id} name="${node.name}" role=${node.role} ` +
          `env=${node.env_tier} tags=[${node.capability_tags.join(',')}] ` +
          `service_roles=[${node.hosted_service_roles.join(',')}]\n`,
      );
    }
    streams.stdout(`\nPolicy document (${policy.rules.length} rule(s)):\n`);
    for (const rule of policy.rules) {
      const when = rule.when !== undefined ? ` when=${JSON.stringify(rule.when)}` : '';
      streams.stdout(
        `  [${rule.effect}] ${rule.id}${when} (${rule.type})\n` +
          (rule.description !== undefined ? `    ${rule.description}\n` : ''),
      );
    }
  }

  return { exitCode: EXIT_OK, result };
}

/**
 * Generate the policy document and write it to `outPath`.
 *
 * @param opts  - Export options.
 * @param deps  - Runtime dependencies.
 * @returns Exit code.
 */
export async function runRulesExport(
  opts: { out?: string },
  deps: RulesCommandDeps,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const outPath = path.resolve(opts.out ?? 'homelab-deploy-policy.json');
  const analyzer = new TopologyAnalyzer(deps.graphStore, { clock: deps.clock });
  const generator = new PolicyGenerator();

  let topology: TopologyDescriptor;
  try {
    topology = await analyzer.analyze();
  } catch (err) {
    printError(`failed to read inventory graph: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }

  const policy = generator.generate(topology);

  try {
    await fs.writeFile(outPath, JSON.stringify(policy, null, 2) + '\n', { encoding: 'utf8' });
  } catch (err) {
    printError(`failed to write policy file to ${outPath}: ${(err as Error).message}`, streams);
    return EXIT_INTERNAL;
  }

  streams.stdout(`Policy document written to ${outPath} (${policy.rules.length} rule(s))\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Commander builder
// ---------------------------------------------------------------------------

/**
 * Build the `rules` command group and wire it to the provided deps.
 *
 * @param deps - Runtime dependencies.
 * @returns Commander command + exit-code accessor.
 */
export function buildRulesCommand(deps: RulesCommandDeps): RulesCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('rules').description(
    'Derive homelab topology facts and generate the deploy policy document (issue #34).',
  );

  cmd
    .command('show')
    .description(
      'Print the topology descriptor (per-node capability facts) and the generated ' +
        'policy document. Read-only — does not modify the graph or enforce rules.',
    )
    .option('--json', 'emit JSON instead of human-readable output')
    .action(async (cmdOpts: { json?: boolean }) => {
      const r = await runRulesShow({ json: cmdOpts.json === true }, { ...deps, streams });
      lastExit = r.exitCode;
    });

  cmd
    .command('export')
    .description(
      'Write the generated policy document to a JSON file for use in the core ' +
        'deploy.policy configuration.',
    )
    .option('--out <path>', 'output file path (default: homelab-deploy-policy.json)')
    .action(async (cmdOpts: { out?: string }) => {
      lastExit = await runRulesExport({ out: cmdOpts.out }, { ...deps, streams });
    });

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}
