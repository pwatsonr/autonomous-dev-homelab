/**
 * Helpers for writing backup-manifest fixtures during tests. SPEC-002-2-05.
 *
 * The orchestrator reads `<HOMELAB_DATA_DIR>/backup-manifest.json`. Each
 * entry has an inline HMAC over the canonical entry minus its own `hmac`
 * field. These helpers produce a properly-signed manifest (or a tampered
 * one) so tests can exercise the verify path without standing up real
 * backup tooling.
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

function signEntry(entry: Omit<BackupManifestEntry, 'hmac'>): BackupManifestEntry {
  const sig = createHmac('sha256', getSecret()).update(canonicalJson(entry)).digest('hex');
  return { ...entry, hmac: sig };
}

function manifestPath(): string {
  const dir = process.env['HOMELAB_DATA_DIR'];
  if (dir === undefined) throw new Error('HOMELAB_DATA_DIR not set');
  return path.join(dir, 'backup-manifest.json');
}

export async function writeBackupManifest(entries: BackupManifestEntry[]): Promise<void> {
  const file = manifestPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ entries }, null, 2));
}

export async function writeFreshBackupManifest(platform: string): Promise<void> {
  const entry = signEntry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date().toISOString(),
    location: `/backups/${platform}/latest.tar`,
    size_bytes: 1024,
  });
  await writeBackupManifest([entry]);
}

export async function writeStaleBackupManifest(platform: string, ageHours = 48): Promise<void> {
  const entry = signEntry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date(Date.now() - ageHours * 3600 * 1000).toISOString(),
    location: `/backups/${platform}/old.tar`,
    size_bytes: 1024,
  });
  await writeBackupManifest([entry]);
}

export async function writeTamperedBackupManifest(platform: string): Promise<void> {
  const valid = signEntry({
    platform,
    backup_type: `${platform}-backup`,
    taken_at: new Date().toISOString(),
    location: `/backups/${platform}/x.tar`,
    size_bytes: 1024,
  });
  // Flip one hex char in the HMAC.
  const tamperedHex = valid.hmac.startsWith('a')
    ? 'b' + valid.hmac.slice(1)
    : 'a' + valid.hmac.slice(1);
  await writeBackupManifest([{ ...valid, hmac: tamperedHex }]);
}

export { signEntry as signBackupEntry };
