/**
 * Atomic file-write helper. Implements SPEC-001-1-03 §"Atomic Write Helper".
 *
 * 1. open `${targetPath}.tmp.${pid}.${rand}` with O_WRONLY|O_CREAT|O_EXCL
 * 2. write all bytes
 * 3. fsync
 * 4. close
 * 5. rename onto targetPath
 * 6. fsync the parent directory (so the rename is durable)
 *
 * Throws if any step fails; cleans up the temp file on failure.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface AtomicWriteOpts {
  /** Mode for the destination file. Defaults to 0o644. */
  mode?: number;
  /**
   * Override for the random suffix generator. Tests inject a deterministic
   * function so they can assert on the temp-file name pattern.
   */
  randomSuffix?: () => string;
}

export async function atomicWriteFile(
  targetPath: string,
  contents: string | Uint8Array,
  opts: AtomicWriteOpts = {},
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = opts.randomSuffix ? opts.randomSuffix() : crypto.randomBytes(6).toString('hex');
  const tempName = `${path.basename(targetPath)}.tmp.${process.pid}.${suffix}`;
  const tempPath = path.join(dir, tempName);
  let handle: import('node:fs/promises').FileHandle | null = null;
  try {
    handle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      opts.mode ?? 0o644,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
    // Best-effort directory fsync. Not all platforms (e.g. Windows) support
    // opening a directory; ignore unsupported errors.
    try {
      const dirHandle = await fs.open(dir, fsConstants.O_RDONLY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // ignore
    }
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fs.unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }
}
