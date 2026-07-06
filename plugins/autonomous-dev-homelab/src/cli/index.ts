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
import {
  runInventoryList,
  runInventoryGet,
  runInventoryRemove,
} from './commands/inventory.js';
import { buildPlatformCommand } from './commands/platform.js';
import { buildAuditCommand } from './commands/audit.js';
import { buildConsentCommand } from './commands/consent.js';
import { buildCACommand } from './commands/ca.js';
import { buildObserveCommand } from './commands/observe.js';
import { buildLiveProbes } from '../observation/live-probes.js';
import { buildSafetyCommand } from './commands/safety.js';
import { buildCancelActionCommand } from './commands/cancel-action.js';
import { buildMigrationsCommand } from './commands/migrations.js';
import { buildMetricsCommand } from './commands/metrics.js';
import { buildPortalCommand } from './commands/portal.js';
import { buildConfigCommand } from './commands/config-validate.js';
import { buildVaultCommand } from './commands/vault-ping.js';
import { buildAutofixCommand } from './commands/autofix.js';
import { assembleRuntime } from '../live/bootstrap.js';
import { runConnectTest } from './commands/connect.js';
import { ObservationCollector } from '../observation/collector.js';
import { DedupCache } from '../observation/dedup.js';
import { ObservationStore } from '../observation/persistence.js';
import { ObservationPromoter } from '../observation/promoter.js';
import {
  enforceAdminIfRequired,
  buildAdminAuthContext,
  type AdminCheckFn,
} from './middleware/admin-auth.js';
import { SSHCertificateManager } from '../ca/manager.js';
import { PassphraseProvider } from '../ca/passphrase.js';
import { ConnectionPool } from '../connection/pool.js';
import { createConnection } from '../connection/factory.js';
import { MCPDiscovery } from '../connection/mcp-discovery.js';
import { AuditKeyStore } from '../audit/key-store.js';
import { AuditWriter } from '../audit/writer.js';
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
  /**
   * Override the admin-role resolver (SPEC-001-3-04 §"Admin Auth
   * Middleware"). Tests inject; production uses the env-var/file default.
   */
  isAdmin?: AdminCheckFn;
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
  // Set by the admin-auth hook when the operator is rejected. The
  // dispatcher honours this flag by returning EXIT_USAGE without invoking
  // the action handler. We thread through `process.exit`-on-reject as a
  // soft hook so tests can drive the same path without killing the
  // worker.
  let adminBlocked = false;
  const adminExit = (_code: number): void => {
    adminBlocked = true;
  };
  const adminCheckOpts = {
    streams,
    exit: adminExit,
    ...(opts.isAdmin !== undefined ? { isAdmin: opts.isAdmin } : {}),
  };

  /**
   * Common preAction wrapper: marks `handled`, then invokes the admin
   * middleware for the dotted command name. Returns true if the action
   * should proceed; false if blocked.
   */
  const wrapPreAction = async (
    dottedName: string,
    dataDir: string,
  ): Promise<boolean> => {
    handled = true;
    const ctx = buildAdminAuthContext(dataDir, env);
    const ok = await enforceAdminIfRequired(dottedName, ctx, adminCheckOpts);
    if (!ok) {
      exitCode = EXIT_USAGE;
      return false;
    }
    return true;
  };

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
      const mcpDiscovery = new MCPDiscovery({ env });
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
          mcpDiscovery,
        },
      );
    });

  // `platform` command group: install-ca, connect-test, rotate-key.
  // Wire dependencies fresh per invocation so data-dir overrides are
  // picked up. The build helper attaches its own action handlers; we
  // proxy `handled = true` and the resulting exit code through Commander
  // pre/post hooks.
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const inventoryPath = path.join(dataDir, 'inventory.yaml');
    const inventoryManager = new InventoryManager(inventoryPath);
    const caManager = new SSHCertificateManager({ dataDir });
    const passphrase = new PassphraseProvider({ dataDir });
    // Inventory lookup must happen synchronously inside the pool factory
    // (since `Connection`s are created sync and connected async). We
    // pre-fetch into a small per-pool cache the first time getConnection
    // is called for an id.
    const preloaded = new Map<string, import('../discovery/inventory-types.js').Platform>();
    const ensure = async (id: string): Promise<void> => {
      if (preloaded.has(id)) return;
      const e = await inventoryManager.getPlatform(id);
      if (e !== null) preloaded.set(id, e);
    };
    const pool = new ConnectionPool({}, (id: string) => {
      const entry = preloaded.get(id);
      if (entry === undefined) {
        throw new Error(`platform '${id}' not loaded; ensure() not called first`);
      }
      return createConnection(id, entry);
    });
    const handle = buildPlatformCommand({
      inventoryManager,
      caManager,
      passphrase,
      pool,
      streams,
    });
    // Mark handled, run admin-auth, then preload the inventory entry.
    handle.command.hook('preAction', async (_thisCommand, actionCommand) => {
      const dottedName = `platform ${actionCommand.name()}`;
      const proceed = await wrapPreAction(dottedName, dataDir);
      if (!proceed) return;
      const platformId = actionCommand.args[0];
      if (typeof platformId === 'string') await ensure(platformId);
    });
    handle.command.hook('postAction', () => {
      if (adminBlocked) return;
      exitCode = handle.lastExitCode();
    });
    program.addCommand(handle.command);
  }

  // `audit` command group: verify + query. (No admin enforcement.)
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const logPath = path.join(dataDir, 'audit.log');
    const keyStore = new AuditKeyStore({ keyPath: path.join(dataDir, '.audit-key') });
    const handle = buildAuditCommand({ logPath, keyStore, streams });
    handle.command.hook('preAction', async (_t, actionCommand) => {
      await wrapPreAction(`audit ${actionCommand.name()}`, dataDir);
    });
    handle.command.hook('postAction', () => {
      if (adminBlocked) return;
      exitCode = handle.lastExitCode();
    });
    program.addCommand(handle.command);
  }

  // `consent` command group: list + grant + revoke. (`revoke` is admin.)
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const consentPath = path.join(dataDir, 'network_consent.yaml');
    const consentManager = new ConsentManager(consentPath, {
      promptFn: buildReadlinePrompter(),
    });
    const handle = buildConsentCommand({ consentManager, streams });
    handle.command.hook('preAction', async (_t, actionCommand) => {
      await wrapPreAction(`consent ${actionCommand.name()}`, dataDir);
    });
    handle.command.hook('postAction', () => {
      if (adminBlocked) return;
      exitCode = handle.lastExitCode();
    });
    program.addCommand(handle.command);
  }

  // `ca` command group: init + rotate + list. (`init` and `rotate` are admin.)
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const inventoryPath = path.join(dataDir, 'inventory.yaml');
    const inventoryManager = new InventoryManager(inventoryPath);
    const caManager = new SSHCertificateManager({ dataDir });
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    handle.command.hook('preAction', async (_t, actionCommand) => {
      await wrapPreAction(`ca ${actionCommand.name()}`, dataDir);
    });
    handle.command.hook('postAction', () => {
      if (adminBlocked) return;
      exitCode = handle.lastExitCode();
    });
    program.addCommand(handle.command);
  }

  // `observe` command group: scan + list + promote.
  //
  // Probe bootstrap: load the operator's homelab config to build live probes
  // from the configured hosts. Each probe receives a real exec source backed
  // by the connection pool so commands run over the live MCP/SSH connection.
  // If no config is present or Vault is unreachable, we fall back to an
  // empty probe list — the CLI remains functional for `list` and `promote`.
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);

    // Attempt to assemble the live runtime (config + Vault + pool) so that
    // probes are backed by real connections. This is best-effort: errors
    // (missing config, Vault unreachable, etc.) fall through to empty probes.
    let observeRuntime: Awaited<ReturnType<typeof assembleRuntime>> | null = null;
    let liveProbes: import('../observation/types.js').Probe[] = [];
    try {
      observeRuntime = await assembleRuntime({ env });
      liveProbes = buildLiveProbes(observeRuntime.config, { pool: observeRuntime.pool });
    } catch {
      // Config absent, Vault unreachable, or other bootstrap error —
      // proceed with empty probe list. `list` and `promote` still work.
      liveProbes = [];
    }

    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter();
    const collector = new ObservationCollector({
      probes: liveProbes,
      dedup,
      store,
      promoter,
    });
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    handle.command.hook('preAction', async (_t, actionCommand) => {
      await wrapPreAction(`observe ${actionCommand.name()}`, dataDir);
    });
    handle.command.hook('postAction', () => {
      if (adminBlocked) return;
      exitCode = handle.lastExitCode();
    });
    program.addCommand(handle.command);
  }

  // SPEC-002-2-04 CLI: `safety check`, `cancel-action`, `migrations status`.
  // These are operator-facing inspection/cancel commands; not admin-gated.
  // `loadAction` is a placeholder pending PLAN-002-1's action store: until
  // that lands, we resolve to null (action not found) so `safety check`
  // returns EXIT_USAGE rather than crashing.
  {
    const safety = buildSafetyCommand({
      streams,
      loadAction: async (_id: string) => null,
    });
    safety.command.hook('preAction', () => {
      handled = true;
    });
    safety.command.hook('postAction', () => {
      exitCode = safety.lastExitCode();
    });
    program.addCommand(safety.command);
  }
  {
    const cancel = buildCancelActionCommand({ streams });
    cancel.command.hook('preAction', () => {
      handled = true;
    });
    cancel.command.hook('postAction', () => {
      exitCode = cancel.lastExitCode();
    });
    program.addCommand(cancel.command);
  }
  {
    const migrations = buildMigrationsCommand({ streams });
    migrations.command.hook('preAction', () => {
      handled = true;
    });
    migrations.command.hook('postAction', () => {
      exitCode = migrations.lastExitCode();
    });
    program.addCommand(migrations.command);
  }
  // SPEC-002-3-03: `homelab metrics show` + `homelab portal`. No admin
  // gating — both commands are read-only operator-facing inspection.
  {
    const metrics = buildMetricsCommand({ streams });
    metrics.command.hook('preAction', () => {
      handled = true;
    });
    metrics.command.hook('postAction', () => {
      exitCode = metrics.lastExitCode();
    });
    program.addCommand(metrics.command);
  }
  {
    const portal = buildPortalCommand({ streams });
    portal.command.hook('preAction', () => {
      handled = true;
    });
    portal.command.hook('postAction', () => {
      exitCode = portal.lastExitCode();
    });
    program.addCommand(portal.command);
  }

  // `config` command group: validate.
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const configHandle = buildConfigCommand({ env, streams });
    configHandle.command.hook('preAction', () => { handled = true; });
    configHandle.command.hook('postAction', () => { exitCode = configHandle.lastExitCode(); });
    void dataDir; // config commands don't use dataDir directly
    program.addCommand(configHandle.command);
  }

  // `vault` command group: ping.
  {
    const vaultHandle = buildVaultCommand({ env, streams });
    vaultHandle.command.hook('preAction', () => { handled = true; });
    vaultHandle.command.hook('postAction', () => { exitCode = vaultHandle.lastExitCode(); });
    program.addCommand(vaultHandle.command);
  }

  // `autofix` command group: propose / dry-run / abort-pending.
  // Needs an AuditWriter; uses the same dataDir as the rest.
  {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    const logPath = path.join(dataDir, 'audit.log');
    const keyStore = new AuditKeyStore({ keyPath: path.join(dataDir, '.audit-key') });
    const auditWriter = new AuditWriter({ logPath, keyStore });
    const autofixHandle = buildAutofixCommand({ audit: auditWriter, streams, dataDir });
    autofixHandle.command.hook('preAction', () => { handled = true; });
    autofixHandle.command.hook('postAction', () => { exitCode = autofixHandle.lastExitCode(); });
    program.addCommand(autofixHandle.command);
  }

  // `connect` command: homelab connect test [--host <h>] [--json]
  // Lazily loads the full runtime (config + Vault) only when invoked.
  {
    const connectCmd = new Command('connect')
      .description('Test connectivity to homelab hosts via MCP or SSH.');
    connectCmd
      .command('test')
      .description('Test MCP/SSH connectivity to all configured hosts.')
      .option('--host <hostname>', 'Test only this host')
      .option('--json', 'Emit JSON output')
      .action(async (cmdOpts: { host?: string; json?: boolean }) => {
        handled = true;
        let runtime: Awaited<ReturnType<typeof assembleRuntime>> | null = null;
        try {
          runtime = await assembleRuntime({ env });
          exitCode = await runConnectTest({
            ...runtime,
            streams,
            json: cmdOpts.json === true,
            hostFilter: cmdOpts.host,
          });
        } catch (err) {
          const e = err as Error & { exit?: number };
          printError(e.message, streams);
          exitCode = typeof e.exit === 'number' ? e.exit : EXIT_INTERNAL;
        } finally {
          if (runtime !== null) {
            await runtime.shutdown().catch(() => undefined);
          }
        }
      });
    program.addCommand(connectCmd);
  }

  const inventoryCmd = program
    .command('inventory')
    .description('Read or manage the discovered-platforms inventory.');
  inventoryCmd.hook('preAction', async (_t, actionCommand) => {
    const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
    await wrapPreAction(`inventory ${actionCommand.name()}`, dataDir);
  });
  inventoryCmd
    .command('list')
    .description('Print discovered platforms.')
    .option('--type <platform>', 'filter by platform type')
    .option('--json', 'emit JSON to stdout instead of a table')
    .action(async (cmdOpts: { type?: string; json?: boolean }) => {
      if (adminBlocked) return;
      const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
      const inventoryPath = path.join(dataDir, 'inventory.yaml');
      const inventoryManager = new InventoryManager(inventoryPath);
      exitCode = await runInventoryList(
        { type: cmdOpts.type, json: cmdOpts.json === true },
        { inventoryManager, streams },
      );
    });
  inventoryCmd
    .command('get')
    .description('Print one platform record (YAML-style or JSON).')
    .argument('<platform-id>', 'platform identifier')
    .option('--json', 'emit JSON instead of YAML')
    .action(async (platformId: string, cmdOpts: { json?: boolean }) => {
      if (adminBlocked) return;
      const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
      const inventoryPath = path.join(dataDir, 'inventory.yaml');
      const inventoryManager = new InventoryManager(inventoryPath);
      exitCode = await runInventoryGet(
        { platformId, json: cmdOpts.json === true },
        { inventoryManager, streams },
      );
    });
  inventoryCmd
    .command('remove')
    .description('Revoke the cert and remove the platform record. (admin)')
    .argument('<platform-id>', 'platform identifier')
    .option('--json', 'emit JSON instead of human-readable output')
    .option('--yes', 'skip the interactive confirmation prompt')
    .action(async (platformId: string, cmdOpts: { json?: boolean; yes?: boolean }) => {
      if (adminBlocked) return;
      const dataDir = resolveDataDir(program.opts().dataDir as string | undefined, env);
      const inventoryPath = path.join(dataDir, 'inventory.yaml');
      const inventoryManager = new InventoryManager(inventoryPath);
      const caManager = new SSHCertificateManager({ dataDir });
      exitCode = await runInventoryRemove(
        {
          platformId,
          json: cmdOpts.json === true,
          ...(cmdOpts.yes === true ? { yes: true } : {}),
        },
        { inventoryManager, caManager, streams },
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

// Execute when run directly as a CLI (CommonJS `require.main === module`).
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runCli({ argv: process.argv.slice(2) }).then((code) => {
    process.exit(code);
  });
}
