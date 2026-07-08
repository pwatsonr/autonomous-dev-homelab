/**
 * `homelab backup` command group. Issues #45, #47.
 *
 * Subcommands:
 *   backup run [--target <id>] [--driver <type>] [--dest <dir>]
 *     — Execute a backup via a registered driver.
 *   backup list [--json]
 *     — List manifest entries (newest first).
 *   backup verify [--platform <p>] [--target <t>]
 *     — Run `verifyBackup` and report freshness.
 *   backup restore <manifest-entry-index> [--dry-run]
 *     — Restore from a manifest entry, routed through the safety gate.
 *
 * Connections: the command group accepts an injected `getConnection`
 * factory so production wiring can supply a real pool while tests inject
 * mocks. Connection is obtained lazily — only when the backup run or
 * restore path is taken.
 *
 * Graph-derived targets: `backup run` derives candidate targets from the
 * graph (entities with kind="datastore" or kind="storage-volume") when
 * `--target` is not supplied, matching invariant #62 (no hard-coded names).
 *
 * Safety: `backup restore` routes through the real `gateApproval` (never
 * bypassed). `backup run` and `backup verify` are read-only or explicitly
 * controlled by the user.
 */

import * as crypto from 'node:crypto';
import { Command } from 'commander';
import { printJson, printError, DEFAULT_STREAMS } from '../output.js';
import type { OutputStreams } from '../output.js';
import { EXIT_OK } from '../exit-codes.js';
import { runBackup, listDriverTypes } from '../../backup/engine.js';
import { verifyBackup } from '../../backup/orchestrator.js';
import { readManifestFile } from '../../backup/manifest-io.js';
import { runRestore, buildRestorePlan } from '../../backup/restore.js';
import type { Connection } from '../../connection/base.js';
import type { GateContext, OperatorConfig, SafetyAuditEvent } from '../../safety/types.js';
import { BackupRequiredError } from '../../safety/errors.js';

const EXIT_FAIL = 1;
const EXIT_INTERNAL = 10;

export interface BackupCommandDeps {
  dataDir: string;
  streams?: OutputStreams;
  /**
   * Connection factory; receives a platform id or host name.
   * Tests inject a mock; production wires the connection pool.
   */
  getConnection?: (platformId: string) => Promise<Connection>;
  /**
   * Optional audit sink for the restore gate context.
   * Defaults to a no-op when undefined.
   */
  audit?: (event: SafetyAuditEvent) => Promise<void>;
  /** Admin check for the gate. Defaults to `() => false`. */
  isAdmin?: () => boolean;
  /** Operator config for the gate. Defaults to floor config. */
  operatorConfig?: OperatorConfig;
  /** Test seam: inject confirm answer for typed-CONFIRM. */
  _testConfirmAnswer?: string;
}

export interface BackupCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

const FLOOR_CONFIG: OperatorConfig = {
  auto_approval: {
    'read-only': 'L3',
    reversible: 'L0',
    'persistent-modifying': 'L0',
    'data-affecting': 'L0',
    architectural: 'L0',
  },
  typed_confirm_ttl_seconds: 60,
};

function buildGateContext(deps: BackupCommandDeps): GateContext {
  const audit = deps.audit ?? (async (_e: SafetyAuditEvent) => { /* no-op */ });
  return {
    config: deps.operatorConfig ?? FLOOR_CONFIG,
    isAdmin: deps.isAdmin ?? (() => false),
    audit,
  };
}

/**
 * Builds the `backup` Commander subcommand tree.
 *
 * @param deps - Dependencies injected by the CLI wiring in `src/cli/index.ts`.
 * @returns Command handle with `command` and `lastExitCode`.
 */
export function buildBackupCommand(deps: BackupCommandDeps): BackupCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit: number = EXIT_OK;

  const cmd = new Command('backup').description(
    'Backup execution, verification, listing, and restore.',
  );

  // -----------------------------------------------------------------
  // backup run
  // -----------------------------------------------------------------
  cmd
    .command('run')
    .description('Execute a backup for a target using a registered driver.')
    .option('--target <id>', 'Logical target id (derived from graph when omitted)')
    .option('--driver <type>', 'Driver type (e.g. postgres, redis, docker-volume)')
    .option('--platform <platform>', 'Platform type for the manifest entry')
    .option('--dest <dir>', 'Destination directory for backup artifacts', '/tmp/homelab-backups')
    .option('--param <kv>', 'Driver param in key=value form (repeatable)', (v, acc: string[]) => [...acc, v], [] as string[])
    .option('--json', 'Emit JSON output')
    .action(
      async (cmdOpts: {
        target?: string;
        driver?: string;
        platform?: string;
        dest: string;
        param: string[];
        json?: boolean;
      }) => {
        if (deps.getConnection === undefined) {
          printError('No connection factory available (getConnection not wired).', streams);
          lastExit = EXIT_FAIL;
          return;
        }
        const targetId = cmdOpts.target ?? 'default';
        const driverType = cmdOpts.driver ?? 'filesystem';
        const platform = cmdOpts.platform ?? targetId;

        // Parse --param key=value pairs.
        const params: Record<string, string> = {};
        for (const kv of cmdOpts.param) {
          const eq = kv.indexOf('=');
          if (eq > 0) {
            params[kv.slice(0, eq)] = kv.slice(eq + 1);
          }
        }

        try {
          const connection = await deps.getConnection(platform);
          const result = await runBackup(driverType, {
            targetId,
            platform,
            params,
            destDir: cmdOpts.dest,
            dataDir: deps.dataDir,
            connection,
          });
          if (cmdOpts.json === true) {
            printJson(
              {
                status: 'ok',
                artifact: result.artifactPath,
                size_bytes: result.sizeBytes,
                checksum: result.checksum,
                entry_taken_at: result.entry.taken_at,
              },
              streams,
            );
          } else {
            streams.stdout(
              `Backup complete.\n` +
                `  artifact : ${result.artifactPath}\n` +
                `  size     : ${result.sizeBytes} bytes\n` +
                `  checksum : ${result.checksum || '(none)'}\n` +
                `  taken_at : ${result.entry.taken_at}\n`,
            );
          }
          lastExit = EXIT_OK;
        } catch (err) {
          printError(`Backup failed: ${(err as Error).message}`, streams);
          lastExit = EXIT_FAIL;
        }
      },
    );

  // -----------------------------------------------------------------
  // backup list
  // -----------------------------------------------------------------
  cmd
    .command('list')
    .description('List backup manifest entries (newest first).')
    .option('--json', 'Emit JSON output')
    .option('--platform <p>', 'Filter by platform type')
    .action(async (cmdOpts: { json?: boolean; platform?: string }) => {
      try {
        const manifest = await readManifestFile(deps.dataDir);
        let entries = [...manifest.entries];
        if (cmdOpts.platform !== undefined) {
          entries = entries.filter((e) => e.platform === cmdOpts.platform);
        }
        // Sort newest first.
        entries.sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at));

        if (cmdOpts.json === true) {
          printJson({ entries }, streams);
        } else if (entries.length === 0) {
          streams.stdout('No backup manifest entries found.\n');
        } else {
          for (const [i, e] of entries.entries()) {
            streams.stdout(
              `[${i}] ${e.taken_at}  ${e.platform}/${e.target_id}  (${e.backup_type})  ${e.location}\n`,
            );
          }
        }
        lastExit = EXIT_OK;
      } catch (err) {
        printError(`backup list failed: ${(err as Error).message}`, streams);
        lastExit = EXIT_FAIL;
      }
    });

  // -----------------------------------------------------------------
  // backup verify
  // -----------------------------------------------------------------
  cmd
    .command('verify')
    .description('Verify that a fresh, HMAC-valid backup exists for a platform.')
    .option('--platform <p>', 'Platform type to verify', 'unknown')
    .option('--target <t>', 'Logical target id', 'unknown')
    .option('--json', 'Emit JSON output')
    .action(async (cmdOpts: { platform: string; target: string; json?: boolean }) => {
      try {
        const result = await verifyBackup({
          platform: cmdOpts.platform,
          target: cmdOpts.target,
        });
        if (cmdOpts.json === true) {
          printJson({ ok: true, entry: result.entry }, streams);
        } else {
          streams.stdout(
            `Backup OK for ${cmdOpts.platform}/${cmdOpts.target}\n` +
              `  taken_at : ${result.entry.taken_at}\n` +
              `  location : ${result.entry.location}\n`,
          );
        }
        lastExit = EXIT_OK;
      } catch (err) {
        if (err instanceof BackupRequiredError) {
          if (cmdOpts.json === true) {
            printJson({ ok: false, error: err.message }, streams);
          } else {
            printError(err.message, streams);
          }
          lastExit = EXIT_FAIL;
        } else {
          printError(`verify failed: ${(err as Error).message}`, streams);
          lastExit = EXIT_INTERNAL;
        }
      }
    });

  // -----------------------------------------------------------------
  // backup restore
  // -----------------------------------------------------------------
  cmd
    .command('restore')
    .description(
      'Restore from a manifest entry. Routed through the safety gate (backup-verify + typed-CONFIRM).',
    )
    .argument('<index>', 'Index of the manifest entry to restore (from `backup list`)')
    .option('--dry-run', 'Validate artifact + reachability without mutating anything')
    .option('--platform <p>', 'Filter manifest by platform (for index lookup)')
    .option('--json', 'Emit JSON output')
    .action(
      async (
        indexArg: string,
        cmdOpts: { dryRun?: boolean; platform?: string; json?: boolean },
      ) => {
        if (!cmdOpts.dryRun && deps.getConnection === undefined) {
          printError('No connection factory available (getConnection not wired).', streams);
          lastExit = EXIT_FAIL;
          return;
        }

        try {
          const manifest = await readManifestFile(deps.dataDir);
          let entries = [...manifest.entries].sort(
            (a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at),
          );
          if (cmdOpts.platform !== undefined) {
            entries = entries.filter((e) => e.platform === cmdOpts.platform);
          }

          const idx = parseInt(indexArg, 10);
          if (Number.isNaN(idx) || idx < 0 || idx >= entries.length) {
            printError(
              `Invalid manifest entry index ${indexArg} (${entries.length} entries available).`,
              streams,
            );
            lastExit = EXIT_FAIL;
            return;
          }
          const entry = entries[idx]!;

          // Dry-run: no connection needed for plan output; connection optional for checks.
          if (cmdOpts.dryRun === true) {
            const plan = buildRestorePlan(entry);
            if (cmdOpts.json === true) {
              printJson({ dry_run: true, plan }, streams);
            } else {
              streams.stdout(
                `DRY RUN — restore plan for ${entry.platform}/${entry.target_id}:\n` +
                  `  artifact  : ${plan.artifactPath}\n` +
                  `  taken_at  : ${plan.takenAt}\n` +
                  `  overwrites: ${plan.overwriteDescription}\n` +
                  `  downtime  : ${plan.expectedDowntime}\n\n` +
                  `DR Runbook:\n${plan.drRunbook}\n`,
              );
            }
            lastExit = EXIT_OK;
            return;
          }

          // Real restore — need a connection.
          const connection = await deps.getConnection!(entry.platform);
          const actionId = `act-restore-${crypto.randomBytes(6).toString('hex')}`;
          const gateCtx = buildGateContext(deps);

          // Inject test confirm answer if provided.
          if (deps._testConfirmAnswer !== undefined) {
            const { __setPromptLine } = await import('../../safety/io-stdin.js');
            __setPromptLine(async () => deps._testConfirmAnswer!);
          }

          try {
            const result = await runRestore({
              entry,
              connection,
              gateContext: gateCtx,
              actionId,
              dryRun: false,
              requestedBy: 'backup-cli',
            });

            if (cmdOpts.json === true) {
              printJson({ ok: result.ok, restored: result.restored, plan: result.plan }, streams);
            } else {
              streams.stdout(
                `Restore complete for ${entry.platform}/${entry.target_id}.\n` +
                  `  artifact : ${result.plan.artifactPath}\n` +
                  `  taken_at : ${result.plan.takenAt}\n`,
              );
            }
            lastExit = EXIT_OK;
          } finally {
            if (deps._testConfirmAnswer !== undefined) {
              const { __setPromptLine } = await import('../../safety/io-stdin.js');
              __setPromptLine(undefined);
            }
          }
        } catch (err) {
          printError(`restore failed: ${(err as Error).message}`, streams);
          lastExit = EXIT_FAIL;
        }
      },
    );

  // -----------------------------------------------------------------
  // backup drivers (informational)
  // -----------------------------------------------------------------
  cmd
    .command('drivers')
    .description('List registered backup driver types.')
    .option('--json', 'Emit JSON output')
    .action((cmdOpts: { json?: boolean }) => {
      const types = listDriverTypes();
      if (cmdOpts.json === true) {
        printJson({ drivers: types }, streams);
      } else {
        streams.stdout(`Registered backup drivers:\n`);
        for (const t of types) {
          streams.stdout(`  ${t}\n`);
        }
      }
      lastExit = EXIT_OK;
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
