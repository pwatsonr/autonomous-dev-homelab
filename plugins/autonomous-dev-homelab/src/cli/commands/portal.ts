/**
 * `homelab portal` command per SPEC-002-3-03.
 *
 * Resolves the portal base URL from autonomous-dev's portal config and
 * opens `<base_url>/portal/homelab` via `open` (macOS) / `xdg-open`
 * (Linux). Verifies the portal is reachable via a 1s health probe; exits
 * non-zero on failure so operators don't open a dead URL.
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { EXIT_INTERNAL, EXIT_OK } from '../exit-codes.js';
import { printError, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface PortalCommandDeps {
  streams?: OutputStreams;
  /** Override for tests. Default: looks up `portal.base_url` env. */
  resolveBaseUrl?: () => string;
  /** Override the spawn used for opening the browser. Default `child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Override the health probe. Default: a fetch with 1s timeout. */
  healthProbe?: (url: string) => Promise<boolean>;
  /** OS hint for the open command. Default `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface PortalCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:19280';

function defaultResolveBaseUrl(): string {
  const fromEnv = process.env['HOMELAB_PORTAL_BASE_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return DEFAULT_BASE_URL;
}

async function defaultHealthProbe(baseUrl: string): Promise<boolean> {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const res = await (f as (u: string, i: { signal: AbortSignal }) => Promise<{ ok: boolean }>)(
      `${baseUrl}/portal/health`,
      { signal: controller.signal },
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openCommandFor(platform: NodeJS.Platform): { bin: string; args: string[] } | null {
  if (platform === 'darwin') return { bin: 'open', args: [] };
  if (platform === 'linux') return { bin: 'xdg-open', args: [] };
  return null;
}

export function buildPortalCommand(deps: PortalCommandDeps = {}): PortalCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const resolveBaseUrl = deps.resolveBaseUrl ?? defaultResolveBaseUrl;
  const spawnFn = deps.spawnFn ?? spawn;
  const healthProbe = deps.healthProbe ?? defaultHealthProbe;
  const platform = deps.platform ?? process.platform;
  let lastExit = EXIT_OK;

  const cmd = new Command('portal')
    .description('Open the homelab portal panel in the operator browser.')
    .option('--no-open', 'print the URL only; do not invoke a browser opener')
    .action(async (opts: { open?: boolean }) => {
      const baseUrl = resolveBaseUrl();
      const fullUrl = `${baseUrl.replace(/\/+$/, '')}/portal/homelab`;
      const ok = await healthProbe(baseUrl);
      if (!ok) {
        printError(`portal health probe failed at ${baseUrl}/portal/health`, streams);
        lastExit = EXIT_INTERNAL;
        return;
      }
      streams.stdout(`${fullUrl}\n`);
      if (opts.open === false) {
        lastExit = EXIT_OK;
        return;
      }
      const opener = openCommandFor(platform);
      if (opener === null) {
        streams.stdout('(no platform-native opener; URL printed above)\n');
        lastExit = EXIT_OK;
        return;
      }
      try {
        spawnFn(opener.bin, [...opener.args, fullUrl], { detached: true, stdio: 'ignore' });
        lastExit = EXIT_OK;
      } catch (err) {
        printError(`failed to spawn ${opener.bin}: ${(err as Error).message}`, streams);
        lastExit = EXIT_INTERNAL;
      }
    });

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}
