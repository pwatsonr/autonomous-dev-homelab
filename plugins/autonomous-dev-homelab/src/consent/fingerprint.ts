/**
 * OS-aware best-effort network fingerprinting.
 *
 * Composes a stable string from the default gateway and DNS resolvers so
 * ConsentManager can detect when the daemon moves networks (preventing
 * drive-by scans on coffee-shop WiFi).
 *
 * Per SPEC-001-1-01:
 * - Linux:  `ip -4 route show default`  → parse `default via <ip> dev ...`
 * - macOS:  `route -n get default`      → parse line `gateway: <ip>`
 * - Other:  throw NO_DEFAULT_GW (caller falls back to `unknown`).
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as os from 'node:os';

const execFile = promisify(execFileCb);

/** Override env var: when set, computeFingerprint returns this verbatim. */
export const OVERRIDE_ENV = 'AUTONOMOUS_DEV_HOMELAB_NETWORK_FINGERPRINT_OVERRIDE';

export interface FingerprintRuntime {
  /** Defaults to Node's child_process.execFile. Overridable for tests. */
  execFile?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Defaults to fs/promises.readFile. Overridable for tests. */
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  /** Defaults to os.platform(). Overridable for tests. */
  platform?: () => NodeJS.Platform;
  /** Defaults to process.env. Overridable for tests. */
  env?: NodeJS.ProcessEnv;
}

interface ResolvedRuntime {
  execFile: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  platform: () => NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function resolveRuntime(rt?: FingerprintRuntime): ResolvedRuntime {
  return {
    execFile: rt?.execFile ?? ((cmd, args) => execFile(cmd, args)),
    readFile: rt?.readFile ?? ((path, encoding) => readFile(path, encoding)),
    platform: rt?.platform ?? (() => os.platform()),
    env: rt?.env ?? process.env,
  };
}

export class NoDefaultGatewayError extends Error {
  public readonly code = 'NO_DEFAULT_GW';
  constructor(message: string) {
    super(message);
    this.name = 'NoDefaultGatewayError';
  }
}

/**
 * Detects the OS, runs the appropriate command, and returns the gateway IP.
 * Throws NoDefaultGatewayError if no default route exists.
 */
export async function getDefaultGateway(rt?: FingerprintRuntime): Promise<string> {
  const runtime = resolveRuntime(rt);
  const platform = runtime.platform();
  if (platform === 'linux') {
    const { stdout } = await runtime.execFile('ip', ['-4', 'route', 'show', 'default']);
    // Example: `default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100`
    const match = /default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(stdout);
    if (!match || !match[1]) {
      throw new NoDefaultGatewayError('no default route found in `ip route` output');
    }
    return match[1];
  }
  if (platform === 'darwin') {
    const { stdout } = await runtime.execFile('route', ['-n', 'get', 'default']);
    // Example line: `   gateway: 192.168.1.1`
    const match = /^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(stdout);
    if (!match || !match[1]) {
      throw new NoDefaultGatewayError('no gateway line found in `route get default` output');
    }
    return match[1];
  }
  throw new NoDefaultGatewayError(`unsupported platform for default-gateway probing: ${platform}`);
}

/**
 * Reads `/etc/resolv.conf` and returns nameserver IPs in declared order, deduped.
 * Returns [] if the file is missing or unreadable.
 */
export async function getDnsServers(rt?: FingerprintRuntime): Promise<string[]> {
  const runtime = resolveRuntime(rt);
  let raw: string;
  try {
    raw = await runtime.readFile('/etc/resolv.conf', 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^nameserver\s+(\S+)/i.exec(line);
    if (!match || !match[1]) continue;
    const ip = match[1];
    if (!seen.has(ip)) {
      seen.add(ip);
      result.push(ip);
    }
  }
  return result;
}

/**
 * Composes the fingerprint string `route=<gw>;dns=<dns1,dns2>`.
 *
 * - Honors the OVERRIDE_ENV environment variable: when set, returns that string verbatim.
 * - On any underlying-command failure, returns `route=unknown;dns=`. Consents
 *   stored under `unknown` match `unknown` only; the operator must re-approve
 *   if the underlying tooling later starts working.
 */
export async function computeFingerprint(rt?: FingerprintRuntime): Promise<string> {
  const runtime = resolveRuntime(rt);
  const override = runtime.env[OVERRIDE_ENV];
  if (override !== undefined) {
    return override;
  }
  let gw: string;
  try {
    gw = await getDefaultGateway(rt);
  } catch {
    return 'route=unknown;dns=';
  }
  let dns: string[];
  try {
    dns = await getDnsServers(rt);
  } catch {
    dns = [];
  }
  return `route=${gw};dns=${dns.join(',')}`;
}
