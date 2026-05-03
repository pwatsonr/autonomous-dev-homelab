/**
 * `AuditKeyStore`: loads or generates the homelab audit HMAC key.
 * SPEC-001-3-02 §"`AuditKeyStore`".
 *
 * The key file (`<homelab-data>/.audit-key`) is `64 hex chars + '\n'`,
 * mode 0600. On first call: generate via `crypto.randomBytes(32)` and
 * persist atomically. On subsequent calls: read and parse the existing
 * key. If the on-disk mode is not 0600 a warning is logged but the key
 * is still used (operator may have intentionally tightened/loosened).
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write.js';
import { InvalidAuditKeyError } from './types.js';

export interface AuditKeyStoreLogger {
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: AuditKeyStoreLogger = {};

export interface AuditKeyStoreOptions {
  keyPath: string;
  logger?: AuditKeyStoreLogger;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export class AuditKeyStore {
  private readonly keyPath: string;
  private readonly logger: AuditKeyStoreLogger;
  private cached: Buffer | null = null;

  constructor(opts: AuditKeyStoreOptions) {
    this.keyPath = path.resolve(opts.keyPath);
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /** Return the 32-byte HMAC key, generating + persisting if absent. */
  async getKey(): Promise<Buffer> {
    if (this.cached !== null) return this.cached;

    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.keyPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === null) {
      // Generate fresh.
      const key = crypto.randomBytes(32);
      const hex = key.toString('hex');
      await atomicWriteFile(this.keyPath, hex + '\n', { mode: 0o600 });
      // atomicWriteFile sets mode at create; chmod for any umask interaction.
      await fs.chmod(this.keyPath, 0o600);
      this.cached = key;
      return key;
    }

    const trimmed = raw.replace(/\s+$/g, '');
    if (!HEX64.test(trimmed)) {
      throw new InvalidAuditKeyError(
        `audit key at ${this.keyPath} is not 64 hex chars (got ${trimmed.length})`,
      );
    }

    // Mode warning (best-effort; not all platforms expose mode bits).
    try {
      const stat = await fs.stat(this.keyPath);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        this.logger.warn?.(
          `audit key file mode is ${mode.toString(8)}; expected 0600 (using key anyway)`,
          { path: this.keyPath },
        );
      }
    } catch {
      // ignore stat failures
    }

    const key = Buffer.from(trimmed, 'hex');
    this.cached = key;
    return key;
  }

  /** Path of the underlying key file (test seam). */
  getKeyPath(): string {
    return this.keyPath;
  }

  /** Test seam: drop the in-memory cache so the next call re-reads disk. */
  clearCache(): void {
    this.cached = null;
  }

  /** True if the key file currently exists on disk. */
  async keyFileExists(): Promise<boolean> {
    try {
      await fs.access(this.keyPath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
