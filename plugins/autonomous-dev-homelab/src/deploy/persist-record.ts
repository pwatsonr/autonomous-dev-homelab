/**
 * Persistence helpers for HMAC-signed deployment records.
 * SPEC-002-3-01 §"Persists the new record at <homelab-data>/...".
 *
 * Uses `atomicWriteFile` (SPEC-001-1-03) so partial writes are impossible.
 * Records are read back during rollback; missing-file returns null.
 */

import { promises as fs } from 'node:fs';
import { atomicWriteFile } from '../util/atomic-write.js';
import { signPayload, verifyPayload } from '../safety/hmac.js';

export async function persistSignedRecord<T>(
  filePath: string,
  payload: T,
): Promise<void> {
  const signed = signPayload(payload);
  await atomicWriteFile(filePath, JSON.stringify(signed));
}

export async function readSignedRecord<T>(
  filePath: string,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const signed = JSON.parse(raw) as { payload: T; hmac: string };
  if (!verifyPayload(signed)) {
    throw new Error(`signed record at ${filePath} failed HMAC verification`);
  }
  return signed.payload;
}
