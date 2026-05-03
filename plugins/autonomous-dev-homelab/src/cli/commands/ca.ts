/**
 * `autonomous-dev-homelab ca ...` subcommand group. Implements
 * SPEC-001-3-03 §"`ca init`", §"`ca rotate`", §"`ca list`".
 *
 * Subcommands:
 *   ca init   [--passphrase-file <path>] [--json]      # requiresAdmin
 *   ca rotate <platform-id>             [--json]       # requiresAdmin
 *   ca list                              [--json]
 *
 * Business logic stays in `SSHCertificateManager`. This command group is
 * argument plumbing + output formatting.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as readline from 'node:readline';
import { Command } from 'commander';
import type { SSHCertificateManager } from '../../ca/manager.js';
import type { InventoryManager } from '../../discovery/inventory.js';
import { CAAlreadyExistsError, CAError } from '../../ca/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, printTable, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface CACommandDeps {
  caManager: SSHCertificateManager;
  inventoryManager: InventoryManager;
  streams?: OutputStreams;
  /** Read passphrase from stdin (no echo). Test seam. */
  readPassphrase?: (prompt: string) => Promise<string>;
  /** Returns true when stdin is interactive. Default: process.stdin.isTTY. */
  isTTY?: () => boolean;
  /** Override `fs.stat` for tests. Default: node fs/promises. */
  statFile?: (path: string) => Promise<{ mode: number }>;
}

export interface CACommandHandle {
  command: Command;
  lastExitCode: () => number;
}

export function buildCACommand(deps: CACommandDeps): CACommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('ca').description(
    'SSH certificate-authority lifecycle (init, rotate, list).',
  );

  cmd
    .command('init')
    .description('Initialize the homelab CA. (admin)')
    .option('--passphrase-file <path>', 'read CA passphrase from a 0600-mode file')
    .option('--json', 'emit JSON instead of human-readable output')
    .action(async (cmdOpts: { passphraseFile?: string; json?: boolean }): Promise<void> => {
      lastExit = await runCAInit(cmdOpts, deps, streams);
    });

  cmd
    .command('rotate')
    .description('Revoke and re-sign the cert for a platform. (admin)')
    .argument('<platform-id>', 'platform identifier from inventory')
    .option('--json', 'emit JSON instead of human-readable output')
    .action(
      async (platformId: string, cmdOpts: { json?: boolean }): Promise<void> => {
        lastExit = await runCARotate(platformId, cmdOpts, deps, streams);
      },
    );

  cmd
    .command('list')
    .description('Print every signed cert (active + revoked).')
    .option('--json', 'emit JSON instead of a table')
    .action(async (cmdOpts: { json?: boolean }): Promise<void> => {
      lastExit = await runCAList(cmdOpts, deps, streams);
    });

  return {
    command: cmd,
    lastExitCode: () => lastExit,
  };
}

// ===== init ==============================================================

async function runCAInit(
  opts: { passphraseFile?: string; json?: boolean },
  deps: CACommandDeps,
  streams: OutputStreams,
): Promise<number> {
  let passphrase: string;
  if (opts.passphraseFile !== undefined) {
    const stat = deps.statFile ?? defaultStat;
    let mode: number;
    try {
      const s = await stat(opts.passphraseFile);
      // eslint-disable-next-line no-bitwise
      mode = s.mode & 0o777;
    } catch (err) {
      printError(`cannot stat passphrase file ${opts.passphraseFile}: ${(err as Error).message}`, streams);
      return EXIT_USAGE;
    }
    if (mode !== 0o600) {
      printError(
        `passphrase file ${opts.passphraseFile} has mode ${mode.toString(8)}; expected 0600`,
        streams,
      );
      return EXIT_USAGE;
    }
    let raw: string;
    try {
      raw = await fs.readFile(opts.passphraseFile, 'utf8');
    } catch (err) {
      printError(`cannot read passphrase file: ${(err as Error).message}`, streams);
      return EXIT_USAGE;
    }
    passphrase = raw.replace(/\r?\n$/, '');
  } else {
    const isTTY = (deps.isTTY ?? ((): boolean => process.stdin.isTTY === true))();
    if (!isTTY) {
      printError(
        'CA passphrase required: pass --passphrase-file or run interactively',
        streams,
      );
      return EXIT_USAGE;
    }
    const prompter = deps.readPassphrase ?? defaultReadPassphrase;
    passphrase = await prompter('CA passphrase: ');
  }
  if (passphrase === '') {
    printError('CA passphrase must not be empty', streams);
    return EXIT_USAGE;
  }
  try {
    await deps.caManager.initializeCA(passphrase);
  } catch (err) {
    if (err instanceof CAAlreadyExistsError) {
      if (opts.json === true) {
        printJson(
          { ok: false, error: err.message, code: 'CA_ALREADY_EXISTS' },
          streams,
        );
      } else {
        printError(`${err.message} -- run \`ca rotate\` to issue new certs`, streams);
      }
      return EXIT_USAGE;
    }
    if (err instanceof CAError) {
      printError(`CA init failed: ${err.message}`, streams);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (opts.json === true) {
    printJson({ ok: true, ca_dir: deps.caManager.caDir() }, streams);
  } else {
    streams.stdout(`CA initialized at ${deps.caManager.caDir()}.\n`);
  }
  return EXIT_OK;
}

// ===== rotate ============================================================

async function runCARotate(
  platformId: string,
  opts: { json?: boolean },
  deps: CACommandDeps,
  streams: OutputStreams,
): Promise<number> {
  // Verify the platform exists in inventory; rotate requires it.
  const platform = await deps.inventoryManager.getPlatform(platformId);
  if (platform === null) {
    printError(`platform '${platformId}' not in inventory`, streams);
    return EXIT_USAGE;
  }
  // SSHCertificateManager.rotateKey requires a passphrase. We resolve it
  // through the env var the PassphraseProvider uses, falling back to a
  // hard error: rotation is admin-driven and unattended in CI/scripts;
  // operators using it interactively should set HOMELAB_CA_PASSPHRASE.
  const pp = process.env['HOMELAB_CA_PASSPHRASE'];
  if (pp === undefined || pp === '') {
    printError(
      'CA rotation requires HOMELAB_CA_PASSPHRASE in the environment',
      streams,
    );
    return EXIT_USAGE;
  }
  let result;
  try {
    result = await deps.caManager.rotateKey(platformId, pp);
  } catch (err) {
    if (err instanceof CAError) {
      printError(`rotation failed: ${err.message}`, streams);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (opts.json === true) {
    printJson(
      {
        ok: true,
        platform_id: platformId,
        old_fingerprint: result.oldFingerprint,
        new_fingerprint: result.newFingerprint,
        revoked_at: result.revokedAt,
      },
      streams,
    );
  } else {
    streams.stdout(
      `Rotated cert for ${platformId}; new fingerprint: ${result.newFingerprint}\n`,
    );
  }
  return EXIT_OK;
}

// ===== list ==============================================================

async function runCAList(
  opts: { json?: boolean },
  deps: CACommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const certs = await deps.caManager.listCertificates();
  if (opts.json === true) {
    printJson(certs, streams);
    return EXIT_OK;
  }
  if (certs.length === 0) {
    streams.stdout('No certs signed.\n');
    return EXIT_OK;
  }
  const rows = certs.map((c) => ({
    'PLATFORM-ID': c.platformId,
    SIGNED_AT: '-', // SSHCertificateManager does not persist signed_at; show '-'.
    EXPIRES_AT: c.validBefore !== '' ? c.validBefore : '-',
    STATUS: c.revoked ? 'revoked' : 'active',
  }));
  printTable(
    rows,
    ['PLATFORM-ID', 'SIGNED_AT', 'EXPIRES_AT', 'STATUS'],
    streams,
  );
  return EXIT_OK;
}

// ===== helpers ===========================================================

async function defaultStat(filePath: string): Promise<{ mode: number }> {
  const s = await fs.stat(filePath);
  return { mode: s.mode };
}

async function defaultReadPassphrase(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

// Exported only to keep `fsConstants` typing honest under strict TS for
// future passphrase-file mode checks; intentionally unused at runtime.
void fsConstants;
