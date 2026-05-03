/**
 * HMAC-SHA256 sign/verify helpers for safety state files. SPEC-002-2-02.
 *
 * Used by:
 *   - 24h delay state files (`pending-actions/<id>.json`)
 *   - Migration state files (`migrations/<id>.json`) — SPEC-002-2-04
 *   - Backup manifest entries — SPEC-002-2-04
 *
 * Reuses the deterministic canonicalizer from the audit module
 * (`src/audit/canonical-json.ts`) so we don't ship two implementations
 * of RFC 8785 / JCS-style canonical JSON. Same secret env var
 * (`HOMELAB_HMAC_SECRET`) gates everything; rotating it invalidates
 * pending actions, migration state, and the backup manifest.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../audit/canonical-json.js';

const DEFAULT_ENV = 'HOMELAB_HMAC_SECRET';
const MIN_SECRET_LEN = 32;

/** Loads the HMAC secret from `envVar` (default `HOMELAB_HMAC_SECRET`). */
function getSecret(envVar: string = DEFAULT_ENV): Buffer {
  const v = process.env[envVar];
  if (v === undefined || v.length < MIN_SECRET_LEN) {
    throw new Error(
      `${envVar} must be set and >= ${MIN_SECRET_LEN} chars (got ${v?.length ?? 0}).`,
    );
  }
  return Buffer.from(v, 'utf8');
}

/** A signed payload envelope. */
export interface Signed<T> {
  payload: T;
  /** Lowercase hex HMAC-SHA256 over `canonicalJson(payload)`. */
  hmac: string;
}

/**
 * Returns `{payload, hmac}`. Signs the canonical JSON of `payload` with
 * HMAC-SHA256. Deterministic: same `payload` → same `hmac`.
 */
export function signPayload<T>(payload: T, envVar?: string): Signed<T> {
  const canonical = canonicalJson(payload);
  const sig = createHmac('sha256', getSecret(envVar)).update(canonical).digest('hex');
  return { payload, hmac: sig };
}

/**
 * Verifies that `signed.hmac` matches a fresh signature over the canonical
 * `signed.payload`. Constant-time comparison via `timingSafeEqual`.
 */
export function verifyPayload<T>(signed: Signed<T>, envVar?: string): boolean {
  if (signed === null || typeof signed !== 'object') return false;
  if (typeof signed.hmac !== 'string') return false;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', getSecret(envVar))
      .update(canonicalJson(signed.payload))
      .digest();
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(signed.hmac, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
