/**
 * `homelab vault ping` command.
 * SPEC: REQ-000055 §2.16, TASK-011.
 *
 * Pings the Vault instance configured in the homelab config.
 * Exit codes:
 *   0  reachable and authenticated
 *   20 VaultUnreachableError
 *   21 VaultAuthError
 *   22 VaultPermissionError
 *   11 ConfigInvalidError
 *   12 ConfigNotFoundError
 *
 * Output MUST NOT include the Vault token, role_id, or secret_id.
 */

import { Command } from 'commander';
import { loadHomelabConfig } from '../../config/loader.js';
import { VaultSecretResolver } from '../../secrets/vault-resolver.js';
import { ConfigInvalidError, ConfigNotFoundError } from '../../config/errors.js';
import {
  VaultUnreachableError,
  VaultAuthError,
  VaultPermissionError,
} from '../../secrets/errors.js';
import type { OutputStreams } from '../output.js';
import { DEFAULT_STREAMS } from '../output.js';

export interface VaultPingDeps {
  env?: NodeJS.ProcessEnv;
  streams: OutputStreams;
  configPath?: string;
}

/**
 * Ping Vault using the homelab config.
 * @returns Exit code per the error taxonomy in §3.1.
 */
export async function runVaultPing(deps: VaultPingDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const env = deps.env ?? process.env;

  try {
    const config = await loadHomelabConfig({ path: deps.configPath, env });
    const resolver = new VaultSecretResolver(config.vault, env);
    await resolver.ping();
    streams.stdout(`Vault is reachable at ${config.vault.address}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigInvalidError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    if (err instanceof VaultUnreachableError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    if (err instanceof VaultAuthError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    if (err instanceof VaultPermissionError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    streams.stderr(`unexpected error: ${(err as Error).message}\n`);
    return 1;
  }
}

export interface VaultCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Build the `vault` Commander subcommand tree. */
export function buildVaultCommand(deps: Omit<VaultPingDeps, 'streams'> & { streams?: OutputStreams }): VaultCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = 0;

  const cmd = new Command('vault').description('Vault integration commands.');

  cmd
    .command('ping')
    .description('Ping the Vault instance.')
    .action(async () => {
      lastExit = await runVaultPing({ env: deps.env, streams, configPath: deps.configPath });
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
