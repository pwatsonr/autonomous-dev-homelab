/**
 * Backup verification per SPEC-002-2-04 (TDD-002 §11).
 *
 * Reads `<homelab-data>/backup-manifest.json` (a single JSON document
 * with an `entries` array). Each entry is HMAC-signed inline: the
 * entry's `hmac` field signs the canonical JSON of the entry MINUS its
 * own `hmac` field. This lets operators co-sign entries from their
 * backup tooling using the same secret as the safety/hmac module.
 *
 * `verifyBackup({platform, target})` returns the freshest valid entry
 * for the platform iff it satisfies the freshness rule. Throws
 * `BackupRequiredError` when the manifest is missing, the platform has
 * no entries, or all entries are stale. Throws on HMAC tampering.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '../audit/canonical-json.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BackupRequiredError } from '../safety/errors.js';
import { dataDir } from '../safety/state-paths.js';
import { DEFAULT_FRESHNESS, FALLBACK_MAX_AGE_SECONDS } from './freshness-rules.js';
import type { BackupManifestEntry, BackupVerificationResult } from './types.js';

const HMAC_ENV = 'HOMELAB_HMAC_SECRET';
const MIN_SECRET_LEN = 32;

export interface VerifyInput {
  platform: string;
  target: string;
  /** Per-platform `max_age_seconds` overrides. */
  freshnessOverrides?: Record<string, number>;
}

function manifestPath(): string {
  return path.join(dataDir(), 'backup-manifest.json');
}

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
 * Verifies an entry's inline HMAC. The entry's `hmac` field is excluded
 * from the canonical input (otherwise the field would self-reference).
 */
function verifyEntryHmac(entry: BackupManifestEntry): boolean {
  if (typeof entry.hmac !== 'string' || entry.hmac.length === 0) return false;
  const { hmac, ...rest } = entry;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', getSecret()).update(canonicalJson(rest)).digest();
  } catch {
    return false;
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(hmac, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

interface ManifestFile {
  entries: BackupManifestEntry[];
}

async function readManifest(): Promise<ManifestFile> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(), 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { entries: [] };
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') return { entries: [] };
  const obj = parsed as { entries?: unknown };
  if (!Array.isArray(obj.entries)) return { entries: [] };
  return { entries: obj.entries as BackupManifestEntry[] };
}

/**
 * Returns the freshest valid backup entry for `input.platform`, or
 * throws `BackupRequiredError` if none exists or all are stale. Throws
 * on HMAC tamper.
 */
export async function verifyBackup(input: VerifyInput): Promise<BackupVerificationResult> {
  const manifest = await readManifest();
  if (manifest.entries.length === 0) {
    throw new BackupRequiredError(input.target, input.platform);
  }
  const candidates: BackupManifestEntry[] = [];
  for (const e of manifest.entries) {
    if (!verifyEntryHmac(e)) {
      throw new Error(`Tampered backup-manifest entry for platform=${e.platform}`);
    }
    if (e.platform === input.platform) candidates.push(e);
  }
  if (candidates.length === 0) {
    throw new BackupRequiredError(input.target, input.platform);
  }
  const freshest = [...candidates].sort(
    (a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at),
  )[0];
  if (freshest === undefined) {
    throw new BackupRequiredError(input.target, input.platform);
  }
  const maxAge =
    input.freshnessOverrides?.[input.platform] ??
    DEFAULT_FRESHNESS[input.platform] ??
    FALLBACK_MAX_AGE_SECONDS;
  const ageSeconds = (Date.now() - Date.parse(freshest.taken_at)) / 1000;
  if (ageSeconds > maxAge) {
    throw new BackupRequiredError(
      input.target,
      `${input.platform} (stale: ${Math.floor(ageSeconds / 3600)}h old, limit ${Math.floor(maxAge / 3600)}h)`,
    );
  }
  return { ok: true, entry: freshest };
}
