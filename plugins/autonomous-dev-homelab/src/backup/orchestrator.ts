/**
 * Backup verification per SPEC-002-2-04 (TDD-002 §11) + issue #46.
 *
 * Reads `<homelab-data>/backup-manifest.json` (v2 canonical schema, issue
 * #46). Legacy v1 files (both verifier and overdue-probe shapes) are
 * transparently upgraded via `convertLegacyManifest`.
 *
 * Each entry is HMAC-signed inline: the entry's `hmac` field signs the
 * canonical JSON of the entry MINUS its own `hmac` field, using
 * `HOMELAB_HMAC_SECRET`. The execution engine (engine.ts) co-signs entries
 * natively, so no external tooling is required.
 *
 * `verifyBackup({platform, target})` returns the freshest valid entry
 * for the platform iff it satisfies the freshness rule. Throws
 * `BackupRequiredError` when the manifest is missing, the platform has
 * no entries, or all entries are stale. Throws on HMAC tampering.
 *
 * Freshness resolution (highest priority first):
 *   1. `freshnessOverrides[platform]`
 *   2. `entry.max_age_seconds` (v2 field)
 *   3. `DEFAULT_FRESHNESS[platform]`
 *   4. `FALLBACK_MAX_AGE_SECONDS` (24h)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackupRequiredError } from '../safety/errors.js';
import { dataDir } from '../safety/state-paths.js';
import { DEFAULT_FRESHNESS, FALLBACK_MAX_AGE_SECONDS } from './freshness-rules.js';
import type {
  BackupManifestEntry,
  BackupVerificationResult,
  BackupManifestFile,
} from './types.js';
import { convertLegacyManifest } from './types.js';
import { verifyEntryHmac } from './manifest-hmac.js';

export { signManifestEntry, verifyEntryHmac } from './manifest-hmac.js';

export interface VerifyInput {
  platform: string;
  target: string;
  /** Per-platform `max_age_seconds` overrides. */
  freshnessOverrides?: Record<string, number>;
}

function manifestPath(): string {
  return path.join(dataDir(), 'backup-manifest.json');
}

async function readManifest(): Promise<BackupManifestFile> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(), 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { schema_version: 2, entries: [] };
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  return convertLegacyManifest(parsed);
}

/**
 * Returns the freshest valid backup entry for `input.platform`, or
 * throws `BackupRequiredError` if none exists or all are stale. Throws
 * on HMAC tamper.
 *
 * Entries converted from the v1-overdue-probe shape have empty `hmac` fields
 * and are accepted without HMAC verification (they were never signed; they
 * are only useful for the overdue probe, not for verifyBackup gate checks).
 * Entries with a non-empty `hmac` that fails verification always throw.
 */
export async function verifyBackup(input: VerifyInput): Promise<BackupVerificationResult> {
  const manifest = await readManifest();
  if (manifest.entries.length === 0) {
    throw new BackupRequiredError(input.target, input.platform);
  }
  const candidates: BackupManifestEntry[] = [];
  for (const e of manifest.entries) {
    // Entries with a non-empty HMAC must verify. Entries with an empty HMAC
    // (back-compat v1-overdue upgrades) are skipped for platform-gating but
    // accepted for the overdue probe.
    if (e.hmac !== '' && !verifyEntryHmac(e)) {
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
    freshest.max_age_seconds ??
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
