/**
 * Helpers for writing backup-manifest fixtures during tests. SPEC-002-2-05 + issue #46.
 *
 * The orchestrator reads `<HOMELAB_DATA_DIR>/backup-manifest.json` (v2
 * canonical schema). Each entry has an inline HMAC over the canonical entry
 * minus its own `hmac` field. These helpers produce properly-signed v2
 * manifest entries (or a tampered one) so tests can exercise the verify path
 * without standing up real backup tooling.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { canonicalJson } from '../../src/audit/canonical-json';
import type { BackupManifestEntry } from '../../src/backup/types';

function getSecret(): Buffer {
  const v = process.env['HOMELAB_HMAC_SECRET'];
  if (v === undefined) throw new Error('HOMELAB_HMAC_SECRET not set');
  return Buffer.from(v, 'utf8');
}

/** Signs a v2 entry (minus hmac). */
function signEntry(entry: Omit<BackupManifestEntry, 'hmac'>): BackupManifestEntry {
  const sig = createHmac('sha256', getSecret()).update(canonicalJson(entry)).digest('hex');
  return { ...entry, hmac: sig } as BackupManifestEntry;
}

function manifestPath(): string {
  const dir = process.env['HOMELAB_DATA_DIR'];
  if (dir === undefined) throw new Error('HOMELAB_DATA_DIR not set');
  return path.join(dir, 'backup-manifest.json');
}

/**
 * Writes a v2 manifest with the given entries.
 * Preserves backward compatibility — callers may also use legacy entry shapes
 * by passing them directly; the orchestrator will upgrade on read.
 */
export async function writeBackupManifest(entries: BackupManifestEntry[]): Promise<void> {
  const file = manifestPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schema_version: 2, entries }, null, 2));
}

/** Builds a minimal v2 entry for tests (all required fields filled). */
function buildV2Entry(
  fields: Pick<BackupManifestEntry, 'platform' | 'backup_type' | 'taken_at' | 'location' | 'size_bytes'>,
): Omit<BackupManifestEntry, 'hmac'> {
  return {
    schema_version: 2,
    platform: fields.platform,
    target_id: fields.backup_type,
    backup_type: fields.backup_type,
    taken_at: fields.taken_at,
    location: fields.location,
    size_bytes: fields.size_bytes,
    max_age_seconds: 86_400,
    checksum: '',
    verified: false,
  };
}

export async function writeFreshBackupManifest(platform: string): Promise<void> {
  const entry = signEntry(buildV2Entry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date().toISOString(),
    location: `/backups/${platform}/latest.tar`,
    size_bytes: 1024,
  }));
  await writeBackupManifest([entry]);
}

export async function writeStaleBackupManifest(platform: string, ageHours = 48): Promise<void> {
  const entry = signEntry(buildV2Entry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
    location: `/backups/${platform}/old.tar`,
    size_bytes: 1024,
  }));
  await writeBackupManifest([entry]);
}

export async function writeTamperedBackupManifest(platform: string): Promise<void> {
  const valid = signEntry(buildV2Entry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date().toISOString(),
    location: `/backups/${platform}/x.tar`,
    size_bytes: 1024,
  }));
  // Flip one hex char in the HMAC.
  const tamperedHex = valid.hmac.startsWith('a')
    ? 'b' + valid.hmac.slice(1)
    : 'a' + valid.hmac.slice(1);
  await writeBackupManifest([{ ...valid, hmac: tamperedHex }]);
}

export { signEntry as signBackupEntry };
