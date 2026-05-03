/**
 * SPEC-002-1-05 — kind cluster helpers for the K8s end-to-end test.
 *
 * Wraps `kind create cluster` / `kind delete cluster` and exposes a
 * `isKindAvailable()` precondition probe so the integration test can
 * skip cleanly when `kind` or `docker` is missing from PATH.
 *
 * The cluster name is shared across the suite so a leaked cluster from
 * a previous failed run can be deleted by hand:
 *   `kind delete cluster --name homelab-spec-002-1-05`
 */

import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFileCb);

export const KIND_CLUSTER_NAME = 'homelab-spec-002-1-05';

/**
 * Returns true iff `kind` AND `docker` are both reachable, so the
 * integration test can skip cleanly on dev laptops without docker.
 *
 * Also gates on the `KIND_INTEGRATION` env var: even when both tools
 * are available, the test only runs when `KIND_INTEGRATION=1` is set.
 * This prevents accidental cluster creation during routine `npm test`.
 */
export async function isKindAvailable(): Promise<boolean> {
  if (process.env['KIND_INTEGRATION'] !== '1') return false;
  try {
    await exec('kind', ['version']);
    await exec('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

export interface KindHandle {
  /** Path to the kubeconfig written for this cluster. */
  kubeconfig: string;
}

export async function setupKind(): Promise<KindHandle> {
  await exec('kind', ['create', 'cluster', '--name', KIND_CLUSTER_NAME, '--wait', '60s'], {
    // 90s budget so the timeout window comfortably exceeds `--wait 60s`.
    timeout: 90_000,
  });
  const { stdout } = await exec('kind', ['get', 'kubeconfig', '--name', KIND_CLUSTER_NAME]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kind-kubeconfig-'));
  const kubeconfig = path.join(dir, 'config');
  await fs.writeFile(kubeconfig, stdout, { mode: 0o600 });
  return { kubeconfig };
}

export async function teardownKind(): Promise<void> {
  try {
    await exec('kind', ['delete', 'cluster', '--name', KIND_CLUSTER_NAME], {
      timeout: 60_000,
    });
  } catch {
    // best-effort: we still want test cleanup to proceed.
  }
}

/**
 * Apply a manifest from disk against the kind cluster's kubeconfig.
 * `kubectl` must be on PATH (kind installs require it).
 */
export async function kubectlApply(kubeconfig: string, manifestPath: string): Promise<void> {
  await exec('kubectl', ['--kubeconfig', kubeconfig, 'apply', '-f', manifestPath], {
    timeout: 30_000,
  });
}

/**
 * Poll `kubectl get pod` until the named pod reports CrashLoopBackOff
 * (or any container `waiting.reason` containing "CrashLoop"). Times
 * out after `timeoutMs` ms; throws on timeout so the test fails loudly.
 */
export async function waitForCrashLoop(
  kubeconfig: string,
  podName: string,
  namespace = 'default',
  timeoutMs = 60_000,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec('kubectl', [
        '--kubeconfig',
        kubeconfig,
        '-n',
        namespace,
        'get',
        'pod',
        podName,
        '-o',
        'json',
      ]);
      const obj = JSON.parse(stdout) as {
        status?: {
          containerStatuses?: Array<{
            state?: { waiting?: { reason?: string } };
            restartCount?: number;
          }>;
        };
      };
      const cs = obj.status?.containerStatuses ?? [];
      for (const c of cs) {
        const reason = c.state?.waiting?.reason ?? '';
        if (reason.includes('CrashLoop') || (c.restartCount ?? 0) >= 1) {
          return;
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs).unref?.());
  }
  throw new Error(
    `pod ${namespace}/${podName} did not reach CrashLoopBackOff within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${(lastErr as Error).message})` : ''),
  );
}
