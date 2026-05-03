/**
 * Test helper: build/start/stop the OpenSSH integration container.
 * Implements SPEC-001-2-05 §"Fixture Container".
 *
 * The helper shells out to the Docker CLI via `child_process.execFile`. It
 * is intentionally Docker-only — no Podman/containerd fallback — because
 * the sshd container's behaviour (in particular `kill -HUP 1`) is what we
 * test. Tests gate on `isDockerAvailable()` and skip cleanly when not.
 */

import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as net from 'node:net';

const execFileAsync = promisify(childProcess.execFile);

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'sshd');
const IMAGE_TAG = 'autonomous-dev-homelab-sshd:test';

export interface SshdContainer {
  containerId: string;
  host: string;
  port: number;
  /** `kill -HUP 1` inside the container; reloads sshd without losing host keys. */
  hup(): Promise<void>;
  /** Replace the in-container KRL by `docker cp`'ing a host file in. */
  updateKRL(hostKrlPath: string): Promise<void>;
  stop(): Promise<void>;
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

export async function buildSshdImage(): Promise<void> {
  await execFileAsync('docker', ['build', '-t', IMAGE_TAG, FIXTURE_DIR], { maxBuffer: 10 * 1024 * 1024 });
}

export interface StartOptions {
  caPubPath: string;
  krlPath: string;
}

export async function startSshdContainer(opts: StartOptions): Promise<SshdContainer> {
  // Map container :22 → ephemeral host port (-p 0:22) and read it back.
  const runArgs = [
    'run',
    '-d',
    '--rm',
    '-p',
    '0:22',
    '-v',
    `${path.resolve(opts.caPubPath)}:/etc/ssh/homelab_ca.pub:ro`,
    '-v',
    `${path.resolve(opts.krlPath)}:/etc/ssh/homelab_ca.krl:ro`,
    IMAGE_TAG,
  ];
  const { stdout: idOut } = await execFileAsync('docker', runArgs);
  const containerId = idOut.trim();
  let cleanedUp = false;
  const stop = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await execFileAsync('docker', ['stop', '-t', '1', containerId]);
    } catch {
      // best-effort
    }
  };
  try {
    const port = await readMappedPort(containerId);
    await waitForPort('127.0.0.1', port, 30_000);
    return {
      containerId,
      host: '127.0.0.1',
      port,
      hup: async () => {
        await execFileAsync('docker', ['exec', containerId, 'sh', '-c', 'kill -HUP 1']);
      },
      updateKRL: async (hostKrlPath) => {
        // The KRL is mounted read-only; docker cp into the same path
        // overwrites the file inside the container.
        await execFileAsync('docker', ['cp', path.resolve(hostKrlPath), `${containerId}:/etc/ssh/homelab_ca.krl`]);
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function readMappedPort(containerId: string): Promise<number> {
  const { stdout } = await execFileAsync('docker', ['port', containerId, '22/tcp']);
  // Output e.g. "0.0.0.0:32768\n[::]:32768\n"
  const m = stdout.match(/:(\d+)/);
  if (!m || !m[1]) throw new Error(`could not parse mapped port: ${stdout}`);
  return parseInt(m[1], 10);
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ host, port, timeout: 1000 }, () => {
          sock.end();
          resolve();
        });
        sock.on('error', (e) => {
          lastErr = e;
          reject(e);
        });
        sock.on('timeout', () => {
          sock.destroy();
          reject(new Error('connect timeout'));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`sshd did not become reachable at ${host}:${port} within ${timeoutMs}ms: ${lastErr?.message ?? 'unknown'}`);
}
