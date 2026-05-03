/**
 * HMAC-signed migration state I/O. SPEC-002-2-04.
 *
 * Reuses `signPayload`/`verifyPayload` from the safety/hmac module; same
 * env var, same canonicalizer. State files live at
 * `<homelab-data>/migrations/<id>.json`. Migration ids must be 26-char
 * Crockford base32 ULIDs (regex enforced server-side to prevent
 * path-traversal via crafted ids).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { signPayload, verifyPayload, type Signed } from '../safety/hmac.js';
import { dataDir } from '../safety/state-paths.js';
import type { MigrationState } from './types.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function migrationDir(): string {
  return path.join(dataDir(), 'migrations');
}

export function migrationPath(id: string): string {
  if (!ULID_RE.test(id)) throw new Error(`Invalid migration id: ${id}`);
  return path.join(migrationDir(), `${id}.json`);
}

/** Persists `state` HMAC-signed at `migrations/<id>.json` (mode 0600). */
export async function saveMigrationState(state: MigrationState): Promise<void> {
  await fs.mkdir(migrationDir(), { recursive: true });
  const signed = signPayload(state);
  await fs.writeFile(
    migrationPath(state.migration_id),
    JSON.stringify(signed, null, 2),
    { mode: 0o600 },
  );
}

/** Reads + HMAC-verifies. Throws on tamper or HMAC mismatch. */
export async function loadMigrationState(id: string): Promise<MigrationState> {
  const raw: unknown = JSON.parse(await fs.readFile(migrationPath(id), 'utf8'));
  if (!isSignedMigrationState(raw) || !verifyPayload(raw)) {
    throw new Error(`Tampered migration state: ${id}`);
  }
  return raw.payload;
}

/** Returns every migration whose `overall_status === 'in-flight'`. */
export async function listInFlightMigrations(): Promise<MigrationState[]> {
  const dir = migrationDir();
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  files.sort(); // deterministic order
  const out: MigrationState[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    if (!isSignedMigrationState(raw) || !verifyPayload(raw)) {
      throw new Error(`Tampered migration state: ${f}`);
    }
    if (raw.payload.overall_status === 'in-flight') out.push(raw.payload);
  }
  return out;
}

function isSignedMigrationState(v: unknown): v is Signed<MigrationState> {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as { payload?: unknown; hmac?: unknown };
  if (typeof obj.hmac !== 'string') return false;
  if (obj.payload === null || typeof obj.payload !== 'object') return false;
  const p = obj.payload as Partial<MigrationState>;
  return (
    typeof p.migration_id === 'string' &&
    typeof p.current_phase_index === 'number' &&
    Array.isArray(p.phases)
  );
}
