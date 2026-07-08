/**
 * Atomic read/write helpers for the backup manifest file. Issue #46.
 *
 * The manifest lives at `<homelab-data>/backup-manifest.json` and is a
 * v2 canonical JSON document (`BackupManifestFile`). Reads transparently
 * upgrade legacy v1 files. Writes are atomic (tmp → rename) with mode 0600.
 *
 * A per-file mutex is used to serialize concurrent writes from the engine
 * and the restore runner so no entry is lost.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileMutex } from '../util/file-mutex.js';
import type { BackupManifestEntry, BackupManifestFile } from './types.js';
import { convertLegacyManifest } from './types.js';

const MANIFEST_NAME = 'backup-manifest.json';

/** Module-level mutex instance — one per process; serializes all manifest writes. */
const _mutex = fileMutex();

function manifestPath(dataDir: string): string {
  return path.join(dataDir, MANIFEST_NAME);
}

/**
 * Reads and upgrades the manifest from `dataDir`. Returns an empty v2
 * manifest when the file does not exist. Throws on other I/O errors.
 *
 * @param dataDir - Directory containing `backup-manifest.json`.
 * @returns Parsed v2 manifest.
 */
export async function readManifestFile(dataDir: string): Promise<BackupManifestFile> {
  const p = manifestPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { schema_version: 2, entries: [] };
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  return convertLegacyManifest(parsed);
}

/**
 * Atomically writes the manifest to `dataDir/backup-manifest.json` with
 * mode 0600, serialized within the per-file mutex.
 *
 * @param dataDir - Directory to write the manifest into.
 * @param manifest - V2 manifest to persist.
 */
export async function writeManifestFile(
  dataDir: string,
  manifest: BackupManifestFile,
): Promise<void> {
  const p = manifestPath(dataDir);
  const tmp = p + '.tmp';
  await fs.mkdir(path.dirname(p), { recursive: true });
  const release = await _mutex.acquire(p);
  try {
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600, encoding: 'utf8' });
    await fs.rename(tmp, p);
  } finally {
    release();
  }
}

/**
 * Appends a signed manifest entry to the manifest file under the per-file
 * mutex. If the manifest does not exist, it is created.
 *
 * @param dataDir - Directory containing `backup-manifest.json`.
 * @param entry   - Fully-constructed and HMAC-signed entry to append.
 */
export async function appendManifestEntry(
  dataDir: string,
  entry: BackupManifestEntry,
): Promise<void> {
  const p = manifestPath(dataDir);
  const tmp = p + '.tmp';
  await fs.mkdir(path.dirname(p), { recursive: true });
  const release = await _mutex.acquire(p);
  try {
    const existing = await readManifestFile(dataDir);
    existing.entries.push(entry);
    await fs.writeFile(tmp, JSON.stringify(existing, null, 2), { mode: 0o600, encoding: 'utf8' });
    await fs.rename(tmp, p);
  } finally {
    release();
  }
}
