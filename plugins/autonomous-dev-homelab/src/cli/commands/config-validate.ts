/**
 * `homelab config validate` command.
 * SPEC: REQ-000055 §2.15, TASK-011.
 *
 * Exit codes:
 *   0  valid config
 *   11 ConfigInvalidError
 *   12 ConfigNotFoundError
 */

import { Command } from 'commander';
import { loadHomelabConfig } from '../../config/loader.js';
import { ConfigInvalidError, ConfigNotFoundError } from '../../config/errors.js';
import type { OutputStreams } from '../output.js';
import { DEFAULT_STREAMS } from '../output.js';

export interface ConfigValidateDeps {
  env?: NodeJS.ProcessEnv;
  streams: OutputStreams;
  configPath?: string;
}

/**
 * Validate the homelab config file.
 * @returns Exit code: 0 (valid), 11 (invalid), 12 (not found).
 */
export async function runConfigValidate(deps: ConfigValidateDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  try {
    await loadHomelabConfig({ path: deps.configPath, env: deps.env });
    streams.stdout('Config is valid.\n');
    return 0;
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    if (err instanceof ConfigInvalidError) {
      streams.stderr(`${err.message}\n`);
      return err.exit;
    }
    streams.stderr(`unexpected error: ${(err as Error).message}\n`);
    return 1;
  }
}

export interface ConfigValidateCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Build the `config` Commander subcommand tree. */
export function buildConfigCommand(deps: Omit<ConfigValidateDeps, 'streams'> & { streams?: OutputStreams }): ConfigValidateCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = 0;

  const cmd = new Command('config').description('Config management.');

  cmd
    .command('validate')
    .description('Validate the homelab config file.')
    .option('--config <path>', 'Path to config file')
    .action(async (cmdOpts: { config?: string }) => {
      lastExit = await runConfigValidate({
        env: deps.env,
        streams,
        configPath: cmdOpts.config ?? deps.configPath,
      });
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
