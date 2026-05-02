/**
 * `autonomous-dev-homelab` CLI entrypoint. Implements SPEC-001-1-04
 * §"Argument Parsing".
 *
 * Wires the `discover` and `inventory list` subcommands using commander.
 * Returns an exit code rather than calling `process.exit` so tests can
 * exercise the full router without spawning subprocesses.
 *
 * `<homelab-data>` resolution: the CLI accepts `--data-dir <path>` (or
 * the `AUTONOMOUS_DEV_HOMELAB_DATA_DIR` env var). The eventual integration
 * with autonomous-dev's PLAN-007-X config infrastructure replaces this
 * with a shared resolver; that wiring is out of scope for SPEC-001-1-04.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';
import { Command } from 'commander';
import { ConsentManager } from '../consent/manager.js';
import { PlatformProber } from '../discovery/prober.js';
import { InventoryManager } from '../discovery/inventory.js';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';
import type { Consent } from '../consent/types.js';
import { runDiscover } from './commands/discover.js';
import { runInventoryList } from './commands/inventory.js';
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE } from './exit-codes.js';
import { printError, type OutputStreams, DEFAULT_STREAMS } from './output.js';

const DATA_DIR_ENV = 'AUTONOMOUS_DEV_HOMELAB_DATA_DIR';

export interface RunCliOptions {
  argv: string[];
  streams?: OutputStreams;
  /** Override for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override for tests: returns the data-dir path. Default resolves from
   * --data-dir, then env, then `${cwd}/.autonomous-dev-homelab`.
   */
  resolveDataDir?: (override: string | undefined, env: NodeJS.ProcessEnv) => string;
}

function defaultResolveDataDir(override: string | undefined, env: NodeJS.ProcessEnv): string {
  if (override !== undefined) return path.resolve(override);
  const fromEnv = env[DATA_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.resolve(process.cwd(), '.autonomous-dev-homelab');
}

/**
 * Reads consents directly from the consent file. Used by the discover
 * command when invoked without `--cidr` to enumerate candidate ranges.
 * Mirrors ConsentManager's loader but lives here so we don't break the
 * manager's encapsulation. ConsentManager remains the only writer.
 */
async function listConsentsFromFile(filePath: string): Promise<Consent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = yaml.load(raw);
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return [];
  const file = parsed as { consents?: Consent[] };
  if (!Array.isArray(file.consents)) return [];
  return file.consents;
}

/** Default interactive prompter built on readline for the CLI. */
function buildReadlinePrompter(): (msg: string) => Promise<boolean> {
  return async (msg: string): Promise<boolean> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${msg} `, (a) => resolve(a));
      });
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

/**
 * Top-level CLI router. Returns an exit code. Never throws -- all
 * unexpected errors are caught and surfaced via stderr with exit
 * `EXIT_INTERNAL` (10), per the AC list in SPEC-001-1-04.
 */
export async function runCli(opts: RunCliOptions): Promise<number> {
  const streams = opts.streams ?? DEFAULT_STREAMS;
  const env = opts.env ?? process.env;
  const resolveDataDir = opts.resolveDataDir ?? defaultResolveDataDir;

  let exitCode: number = EXIT_OK;
  let handled = false;

  const program = new Command();
  program
    .name('autonomous-dev-homelab')
    .description('Homelab platform discovery, connection, and lifecycle automation.')
    .option('--data-dir <path>', 'directory for consent + inventory state files')
    .exitOverride() // tell commander to throw rather than process.exit
    .configureOutput({
      writeOut: (s) => streams.stdout(s),
      writeErr: (s) => streams.stderr(s),
    });

  program
    .command('discover')
    .description('Probe a CIDR range for known homelab platforms.')
    .option('--cidr <cidr>', 'scan only this CIDR (default: every consented CIDR)')
    .option('--json', 'emit JSON to stdout instead of human-readable lines')
    .option('--no-prompt', 'never invoke the interactive consent prompt')
    .action(async (cmdOpts: { cidr?: string; json?: boolean; prompt?: boolean }) => {
      handled = true;
      const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
      const consentPath = path.join(dataDir, 'network_consent.yaml');
      const inventoryPath = path.join(dataDir, 'inventory.yaml');
      const consentManager = new ConsentManager(consentPath, {
        promptFn: buildReadlinePrompter(),
      });
      const prober = new PlatformProber();
      const inventoryManager = new InventoryManager(inventoryPath);
      // commander's `--no-prompt` flips `cmdOpts.prompt` to false.
      const noPrompt = cmdOpts.prompt === false;
      exitCode = await runDiscover(
        {
          cidr: cmdOpts.cidr,
          json: cmdOpts.json === true,
          noPrompt,
        },
        {
          consentManager,
          prober,
          inventoryManager,
          streams,
          listConsents: () => listConsentsFromFile(consentPath),
        },
      );
    });

  const inventoryCmd = program
    .command('inventory')
    .description('Read or manage the discovered-platforms inventory.');
  inventoryCmd
    .command('list')
    .description('Print discovered platforms.')
    .option('--type <platform>', 'filter by platform type')
    .option('--json', 'emit JSON to stdout instead of a table')
    .action(async (cmdOpts: { type?: string; json?: boolean }) => {
      handled = true;
      const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
      const inventoryPath = path.join(dataDir, 'inventory.yaml');
      const inventoryManager = new InventoryManager(inventoryPath);
      exitCode = await runInventoryList(
        { type: cmdOpts.type, json: cmdOpts.json === true },
        { inventoryManager, streams },
      );
    });

  try {
    await program.parseAsync(opts.argv, { from: 'user' });
    if (!handled) {
      // No subcommand was matched (e.g., `--help` flow). Commander already
      // emitted the appropriate output; preserve EXIT_OK.
      return EXIT_OK;
    }
    return exitCode;
  } catch (err) {
    // commander.exitOverride throws CommanderError for usage errors and
    // for help/version. Treat help/version as success; everything else
    // as usage.
    const code = (err as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
      return EXIT_OK;
    }
    if (typeof code === 'string' && code.startsWith('commander.')) {
      // Commander already printed the message; just return EXIT_USAGE.
      return EXIT_USAGE;
    }
    // Anything else is a genuine internal error from a handler.
    const e = err as Error;
    printError(`unexpected internal error: ${e.message}`, streams);
    if (e.stack) streams.stderr(e.stack + '\n');
    return EXIT_INTERNAL;
  }
}
