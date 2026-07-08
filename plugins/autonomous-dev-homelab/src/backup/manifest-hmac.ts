/**
 * HMAC sign/verify helpers for backup manifest entries. Issue #46.
 *
 * Reuses the same HMAC-SHA256 + `canonicalJson` pattern as
 * `src/safety/hmac.ts` and `src/backup/orchestrator.ts`, keyed on
 * `HOMELAB_HMAC_SECRET`.
 *
 * The HMAC is computed over `canonicalJson(entry_without_hmac_field)` so the
 * `hmac` field is self-excluding (otherwise it would need to know its own
 * value before it is computed).
 *
 * No plaintext secrets are recorded in the manifest or logs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../audit/canonical-json.js';
import type { BackupManifestEntry } from './types.js';

const HMAC_ENV = 'HOMELAB_HMAC_SECRET';
const MIN_SECRET_LEN = 32;

function getSecret(): Buffer {
  const v = process.env[HMAC_ENV];
  if (v === undefined || v.length < MIN_SECRET_LEN) {
    throw new Error(
      `${HMAC_ENV} must be set and >= ${MIN_SECRET_LEN} chars (got ${v?.length ?? 0}).`,
    );
  }
  return Buffer.from(v, 'utf8');
}

/**
 * Returns a new entry with the `hmac` field set to the HMAC-SHA256 hex of
 * `canonicalJson(entry_without_hmac_field)`. The input entry's `hmac` field
 * is overwritten.
 *
 * @param entry - Entry to sign (may have a stale or empty `hmac`).
 * @returns New entry object with a fresh `hmac`.
 * @throws Error when `HOMELAB_HMAC_SECRET` is not set or too short.
 */
export function signManifestEntry(entry: Omit<BackupManifestEntry, 'hmac'>): BackupManifestEntry {
  const sig = createHmac('sha256', getSecret())
    .update(canonicalJson(entry))
    .digest('hex');
  return { ...entry, hmac: sig } as BackupManifestEntry;
}

/**
 * Verifies the `hmac` field of a manifest entry. Constant-time comparison.
 *
 * Returns `false` (not `throws`) when:
 *   - `entry.hmac` is empty or missing.
 *   - The HMAC does not match.
 *   - `HOMELAB_HMAC_SECRET` is not set (treated as verification failure).
 *
 * Callers that require a hard error on tamper MUST check the return value
 * and throw themselves.
 *
 * @param entry - Entry to verify.
 * @returns `true` iff the HMAC is valid.
 */
export function verifyEntryHmac(entry: BackupManifestEntry): boolean {
  if (typeof entry.hmac !== 'string' || entry.hmac.length === 0) return false;
  const { hmac, ...rest } = entry;
  void hmac;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', getSecret()).update(canonicalJson(rest)).digest();
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(entry.hmac, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
