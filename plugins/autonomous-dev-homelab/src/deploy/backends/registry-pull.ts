/**
 * Shared image-pull helper used by both `ProxmoxHomelabBackend` and
 * `UnraidHomelabBackend`. SPEC-002-3-01 §"Shared registry-pull helper".
 *
 * Backs:
 *   - `UnraidHomelabBackend.build` via `emhttp` `POST /Docker/PullImage`
 *   - `ProxmoxHomelabBackend.build` via `pct pull` over SSH
 *
 * Retries on transient (network / 5xx) failures with 2s/4s/8s backoff,
 * max 3 attempts. Surfaces `DeployError { code: 'IMAGE_PULL_FAILED',
 * retriable: true }` when all retries exhausted.
 */

import { DeployError } from '../errors.js';

export interface PullResult {
  digest: string;
  sizeBytes: number;
  pulledAt: string;
}

export interface PullExecResult {
  success: boolean;
  /** The platform's reported digest when successful. */
  digest?: string;
  /** The platform's reported size when successful. */
  sizeBytes?: number;
  /** Set when the failure is transient (network/5xx). Drives retry. */
  transient?: boolean;
  /** Error message for non-retriable failures. */
  error?: string;
}

export interface PullOpts {
  image: string;
  registry?: string;
  /**
   * Driver supplied by the backend — Unraid wraps the emhttp call;
   * Proxmox wraps `pct pull`. Returns a `PullExecResult`.
   */
  driver: (image: string, registry?: string) => Promise<PullExecResult>;
  /** Sleep injection (tests pass a fake). Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection (tests pin to ISO timestamps). Default: `Date.now`. */
  now?: () => number;
}

const BACKOFF_MS = [2000, 4000, 8000] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export async function pullImage(opts: PullOpts): Promise<PullResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    const result = await opts.driver(opts.image, opts.registry);
    if (
      result.success &&
      typeof result.digest === 'string' &&
      typeof result.sizeBytes === 'number'
    ) {
      return {
        digest: result.digest,
        sizeBytes: result.sizeBytes,
        pulledAt: new Date(now()).toISOString(),
      };
    }
    lastError = result.error ?? 'pull failed';
    if (result.transient !== true) {
      // Permanent failure — do not retry.
      throw new DeployError({
        code: 'IMAGE_PULL_FAILED',
        message: `image pull failed (non-retriable): ${lastError}`,
        retriable: false,
      });
    }
    if (attempt < BACKOFF_MS.length - 1) {
      await sleep(BACKOFF_MS[attempt] as number);
    }
  }
  throw new DeployError({
    code: 'IMAGE_PULL_FAILED',
    message: `image pull failed after ${BACKOFF_MS.length} attempts: ${lastError}`,
    retriable: true,
  });
}
