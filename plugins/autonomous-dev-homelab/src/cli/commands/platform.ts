/**
 * `autonomous-dev-homelab platform ...` subcommand group. Implements
 * SPEC-001-2-04 §"CLI Command Surface".
 *
 * Subcommands:
 *   platform install-ca   <id>   [--json] [--krl]
 *   platform connect-test <id>   [--json] [--timeout <ms>]
 *   platform rotate-key   <id>   [--json] [--force]
 *
 * The factory function `buildPlatformCommand(deps)` returns a Commander
 * subcommand. `deps` injects InventoryManager, SSHCertificateManager,
 * PassphraseProvider, ConnectionPool, output streams, and a confirm
 * prompt — all replaceable for tests.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as readline from 'node:readline';
import { Command } from 'commander';
import type { InventoryManager } from '../../discovery/inventory.js';
import type { SSHCertificateManager } from '../../ca/manager.js';
import type { PassphraseProvider } from '../../ca/passphrase.js';
import type { ConnectionPool } from '../../connection/pool.js';
import type { Connection } from '../../connection/base.js';
import type { Platform as InventoryPlatform } from '../../discovery/inventory-types.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';

/** Generic connect failure exit code (distinct from usage errors). */
export const EXIT_CONNECT_FAIL = 1;

export interface PlatformCommandDeps {
  inventoryManager: InventoryManager;
  caManager: SSHCertificateManager;
  passphrase: PassphraseProvider;
  pool: ConnectionPool;
  streams?: OutputStreams;
  /** Confirm prompt for `rotate-key`. Default: TTY readline; tests inject. */
  confirm?: (msg: string) => Promise<boolean>;
  /** Returns true when stdin is interactive. Default: process.stdin.isTTY. */
  isTTY?: () => boolean;
  /**
   * Resolves a remote ssh principal/user-agnostic OS hint from inventory
   * metadata; the human-readable `install-ca` text uses this to decide
   * whether to suggest `systemctl restart sshd` vs `service sshd reload`.
   * Defaults to "systemctl restart sshd" (Linux assumption).
   */
}

/**
 * Build the `platform` Commander subcommand. Tests instantiate this
 * directly with mocked deps; the real CLI calls it from `cli/index.ts`.
 *
 * Returns an object with both the Commander instance and a helper that
 * lets tests inspect the most recent exit code (Commander itself returns
 * via its action handlers).
 */
export interface PlatformCommandHandle {
  command: Command;
  /** Last exit code set by an action handler. Tests read this. */
  lastExitCode: () => number;
}

export function buildPlatformCommand(deps: PlatformCommandDeps): PlatformCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('platform').description(
    'Per-platform CA install, connection check, and key rotation.',
  );

  // ---- install-ca -------------------------------------------------------
  cmd
    .command('install-ca')
    .description('Print the CA public key plus distribution instructions for a platform.')
    .argument('<platform-id>', 'platform identifier from inventory')
    .option('--json', 'emit JSON to stdout instead of human-readable instructions')
    .option('--krl', 'write the binary KRL to stdout (suitable for redirection)')
    .action(
      async (
        platformId: string,
        cmdOpts: { json?: boolean; krl?: boolean },
      ): Promise<void> => {
        lastExit = await runInstallCA(platformId, cmdOpts, deps, streams);
      },
    );

  // ---- connect-test -----------------------------------------------------
  cmd
    .command('connect-test')
    .description('Open a connection via the pool and run a tiny probe.')
    .argument('<platform-id>', 'platform identifier from inventory')
    .option('--json', 'emit a JSON result document')
    .option('--timeout <ms>', 'overall timeout in milliseconds', (v) => Number.parseInt(v, 10), 15000)
    .action(
      async (
        platformId: string,
        cmdOpts: { json?: boolean; timeout: number },
      ): Promise<void> => {
        lastExit = await runConnectTest(platformId, cmdOpts, deps, streams);
      },
    );

  // ---- rotate-key -------------------------------------------------------
  cmd
    .command('rotate-key')
    .description('Rotate the per-platform user keypair and revoke the old cert.')
    .argument('<platform-id>', 'platform identifier from inventory')
    .option('--json', 'emit a JSON rotation result document')
    .option('--force', 'skip the interactive confirmation prompt')
    .action(
      async (
        platformId: string,
        cmdOpts: { json?: boolean; force?: boolean },
      ): Promise<void> => {
        lastExit = await runRotateKey(platformId, cmdOpts, deps, streams);
      },
    );

  return {
    command: cmd,
    lastExitCode: () => lastExit,
  };
}

// ===== install-ca ========================================================

async function runInstallCA(
  platformId: string,
  opts: { json?: boolean; krl?: boolean },
  deps: PlatformCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const platform = await deps.inventoryManager.getPlatform(platformId);
  if (platform === null) {
    printError(`platform '${platformId}' not in inventory`, streams);
    return EXIT_USAGE;
  }
  if (opts.krl === true) {
    // Write KRL bytes to stdout. ssh-keygen writes to a file; we write to
    // a temp path then stream it.
    let pp: string;
    try {
      pp = (await deps.passphrase.get()).passphrase;
    } catch (err) {
      printError(`unable to obtain CA passphrase: ${(err as Error).message}`, streams);
      return EXIT_USAGE;
    }
    const tmpKRL = path.join(
      deps.caManager.caDir(),
      `homelab_ca.krl-${process.pid}-${Date.now()}`,
    );
    try {
      await deps.caManager.generateKRL(pp, tmpKRL);
      const buf = await fs.readFile(tmpKRL);
      streams.stdout(buf.toString('binary'));
    } finally {
      try {
        await fs.unlink(tmpKRL);
      } catch {
        /* ignore */
      }
    }
    return EXIT_OK;
  }

  const caPub = (await deps.caManager.getCAPublicKey()).trim();
  const remoteCAPath = '/etc/ssh/homelab_ca.pub';
  const remoteKRLPath = '/etc/ssh/homelab_ca.krl';
  const sshdLines = [
    `TrustedUserCAKeys ${remoteCAPath}`,
    `RevokedKeys ${remoteKRLPath}`,
  ];
  if (opts.json === true) {
    printJson(
      {
        platform_id: platformId,
        ca_public_key: caPub,
        sshd_config_lines: sshdLines,
        remote_paths: { ca_pubkey: remoteCAPath, krl: remoteKRLPath },
      },
      streams,
    );
    return EXIT_OK;
  }
  streams.stdout(
    `Add the following two lines to /etc/ssh/sshd_config on ${platform.id}:\n\n` +
      `    ${sshdLines[0]}\n` +
      `    ${sshdLines[1]}\n\n` +
      `Then write the CA public key to ${remoteCAPath}:\n\n` +
      `${caPub}\n\n` +
      `Restart sshd: systemctl restart sshd\n\n` +
      `For automated distribution see the KRL helper:\n` +
      `  autonomous-dev-homelab platform install-ca ${platform.id} --krl > homelab_ca.krl\n`,
  );
  return EXIT_OK;
}

// ===== connect-test ======================================================

async function runConnectTest(
  platformId: string,
  opts: { json?: boolean; timeout: number },
  deps: PlatformCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const platform = await deps.inventoryManager.getPlatform(platformId);
  if (platform === null) {
    printError(`platform '${platformId}' not in inventory`, streams);
    return EXIT_USAGE;
  }
  const timeoutMs = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : 15000;
  let conn: Connection | undefined;
  let connectError: Error | undefined;
  let execResult: { stdout: string; stderr: string; exitCode: number; durationMs: number } | undefined;
  const wallStart = Date.now();
  try {
    conn = await withTimeout(
      deps.pool.getConnection(platformId),
      timeoutMs,
      `connect timed out after ${timeoutMs}ms`,
    );
    const probe = probeCommandFor(platform);
    execResult = await withTimeout(
      conn.exec(probe, { timeoutMs }),
      timeoutMs,
      `exec timed out after ${timeoutMs}ms`,
    );
  } catch (err) {
    connectError = err as Error;
  }
  const wallMs = Date.now() - wallStart;

  const caps = conn?.getCapabilities();
  const ok = connectError === undefined && execResult !== undefined && execResult.exitCode === 0;
  if (opts.json === true) {
    const payload: Record<string, unknown> = {
      platform_id: platformId,
      ok,
      transport: caps?.transport ?? null,
      wall_ms: wallMs,
    };
    if (execResult !== undefined) payload['exec_result'] = execResult;
    if (caps !== undefined) payload['capabilities'] = caps;
    if (connectError !== undefined) {
      payload['error'] = { name: connectError.name, message: connectError.message };
    }
    printJson(payload, streams);
    return ok ? EXIT_OK : EXIT_CONNECT_FAIL;
  }

  if (ok && caps !== undefined && execResult !== undefined) {
    const fpPart = caps.certFingerprint !== undefined ? ` cert_fingerprint=${caps.certFingerprint}` : '';
    const userPart = caps.user !== undefined ? ` user=${caps.user}` : '';
    streams.stdout(
      `OK  ${platformId}  transport=${caps.transport}${userPart}${fpPart}  duration=${execResult.durationMs}ms\n`,
    );
    return EXIT_OK;
  }
  // FAIL path
  const transport = caps?.transport ?? 'unknown';
  const errMsg = connectError !== undefined
    ? `${connectError.name}: ${connectError.message}`
    : `non-zero exit ${execResult?.exitCode ?? '?'}`;
  streams.stdout(
    `FAIL  ${platformId}\n` +
      `  transport: ${transport}\n` +
      `  error:     ${errMsg}\n` +
      `  hint:      Run \`platform install-ca ${platformId}\` to (re-)distribute the CA pubkey.\n`,
  );
  return EXIT_CONNECT_FAIL;
}

function probeCommandFor(platform: InventoryPlatform): string {
  // HTTPS-only and HTTPS-preferring platforms need a JSON descriptor.
  if (platform.type === 'unifi') {
    return JSON.stringify({ method: 'GET', path: '/api/self' });
  }
  if (platform.type === 'truenas') {
    // TrueNAS may fall back to SSH; descriptor works on REST and is parsed
    // (and rejected) by the SSH path, but we send `whoami` for SSH.
    // The conservative choice is to send a descriptor since TrueNAS prefers
    // REST; SSH-fallback callers can override via the connection layer if
    // they need a shell probe.
    return JSON.stringify({ method: 'GET', path: '/api/v2.0/system/info' });
  }
  return 'whoami';
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(label)), ms);
    handle.unref?.();
    p.then(
      (v) => {
        clearTimeout(handle);
        resolve(v);
      },
      (err) => {
        clearTimeout(handle);
        reject(err as Error);
      },
    );
  });
}

// ===== rotate-key ========================================================

async function runRotateKey(
  platformId: string,
  opts: { json?: boolean; force?: boolean },
  deps: PlatformCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const platform = await deps.inventoryManager.getPlatform(platformId);
  if (platform === null) {
    printError(`platform '${platformId}' not in inventory`, streams);
    return EXIT_USAGE;
  }
  const isTTY = (deps.isTTY ?? ((): boolean => process.stdin.isTTY === true))();
  if (opts.force !== true && !isTTY) {
    printError('use --force in non-interactive mode', streams);
    return EXIT_USAGE;
  }
  if (opts.force !== true) {
    const confirmFn = deps.confirm ?? defaultConfirm;
    const proceed = await confirmFn(
      `Rotate key for ${platformId}? This revokes the current cert. [y/N]`,
    );
    if (!proceed) {
      streams.stdout('Aborted; no changes made.\n');
      return EXIT_OK;
    }
  }
  let pp: string;
  try {
    pp = (await deps.passphrase.get()).passphrase;
  } catch (err) {
    printError(`unable to obtain CA passphrase: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }
  let result;
  try {
    result = await deps.caManager.rotateKey(platformId, pp);
  } catch (err) {
    printError(`rotation failed: ${(err as Error).message}`, streams);
    return EXIT_CONNECT_FAIL;
  }
  if (opts.json === true) {
    printJson(
      {
        platform_id: platformId,
        old_fingerprint: result.oldFingerprint,
        new_fingerprint: result.newFingerprint,
        revoked_at: result.revokedAt,
      },
      streams,
    );
    return EXIT_OK;
  }
  streams.stdout(
    `Rotating key for ${platformId}...\n` +
      `  Old cert fingerprint: ${result.oldFingerprint}\n` +
      `  Old cert added to revocation list at ${deps.caManager.revocationListPath()}\n\n` +
      `New keypair generated:\n` +
      `  Private key: ${deps.caManager.userKeyPath(platformId)}  (mode 0600)\n` +
      `  Cert:        ${deps.caManager.userCertPath(platformId)}\n` +
      `  New fingerprint: ${result.newFingerprint}\n\n` +
      `Next steps:\n` +
      `  1. Distribute the updated KRL: autonomous-dev-homelab platform install-ca ${platformId} --krl > homelab_ca.krl\n` +
      `  2. Copy homelab_ca.krl to /etc/ssh/homelab_ca.krl on ${platformId}\n` +
      `  3. Restart sshd on ${platformId}: systemctl restart sshd\n` +
      `  4. Verify: autonomous-dev-homelab platform connect-test ${platformId}\n`,
  );
  return EXIT_OK;
}

async function defaultConfirm(msg: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${msg} `, (a) => resolve(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
