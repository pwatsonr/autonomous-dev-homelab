/**
 * `PassphraseProvider`: resolves the CA passphrase from env, stored blob,
 * or interactive TTY prompt. Implements SPEC-001-2-01
 * §"`src/ca/passphrase.ts`".
 *
 * Hard rules enforced by this module:
 * - Plaintext passphrase MUST NOT be written to any log, file, or error
 *   message produced by this module.
 * - The cached passphrase is held in a mutable `Buffer` that `clear()`
 *   zeroes in place so a process-memory dump after `clear()` does not
 *   yield the secret.
 * - The on-disk format is AES-256-GCM with a per-host key derived from
 *   `<dataDir>/ca/host.key` via PBKDF2-SHA256 (200k iterations, 16-byte
 *   salt).
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { atomicWriteFile } from '../util/atomic-write.js';
import { PassphraseUnavailableError, type PassphraseSource } from './types.js';

const ENV_VAR = 'HOMELAB_CA_PASSPHRASE';
const KDF_ITERATIONS = 200_000;
const KEY_LENGTH = 32; // AES-256
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // GCM standard
const HOST_KEY_LENGTH = 32;
const BLOB_VERSION = 1;

interface StoredBlobV1 {
  version: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string; // hex
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
}

export interface PassphraseProviderOptions {
  /**
   * Source of `<dataDir>` (the homelab data directory). The provider
   * stores its encrypted blob under `<dataDir>/ca/passphrase.enc` and
   * its host key under `<dataDir>/ca/host.key`.
   */
  dataDir: string;
  /** Override for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the readline interface factory. Tests inject a fake reader
   * so the prompt path can be exercised without a TTY.
   */
  readlineFactory?: () => {
    questionHidden(prompt: string): Promise<string>;
    close(): void;
  };
  /** Override `process.stdin.isTTY` for tests. Defaults to actual stdin. */
  isTTY?: () => boolean;
  /** Decipher factory for tests that want to spy. Defaults to crypto.createDecipheriv. */
  createDecipheriv?: typeof crypto.createDecipheriv;
}

export interface PassphraseResult {
  passphrase: string;
  source: PassphraseSource;
}

export class PassphraseProvider {
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readlineFactory?: () => {
    questionHidden(prompt: string): Promise<string>;
    close(): void;
  };
  private readonly isTTY: () => boolean;
  private readonly createDecipheriv: typeof crypto.createDecipheriv;

  /**
   * In-memory cache. `Buffer` (mutable) so `clear()` can zero it. Null
   * when no passphrase has been loaded yet.
   */
  private cache: Buffer | null = null;
  private cachedSource: PassphraseSource | null = null;

  constructor(opts: PassphraseProviderOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.env = opts.env ?? process.env;
    this.readlineFactory = opts.readlineFactory;
    this.isTTY = opts.isTTY ?? ((): boolean => process.stdin.isTTY === true);
    this.createDecipheriv = opts.createDecipheriv ?? crypto.createDecipheriv;
  }

  /**
   * Resolve the passphrase. Order: env > cached > stored > prompt.
   * Subsequent calls within a process return the cached value (and do
   * NOT re-decrypt from disk for the `stored` source).
   */
  async get(): Promise<PassphraseResult> {
    if (this.cache !== null && this.cachedSource !== null) {
      return { passphrase: this.cache.toString('utf8'), source: this.cachedSource };
    }

    const fromEnv = this.env[ENV_VAR];
    if (fromEnv !== undefined && fromEnv !== '') {
      this.cache = Buffer.from(fromEnv, 'utf8');
      this.cachedSource = 'env';
      return { passphrase: fromEnv, source: 'env' };
    }

    const blobPath = this.passphraseBlobPath();
    if (await fileExists(blobPath)) {
      const decrypted = await this.decryptStored(blobPath);
      this.cache = Buffer.from(decrypted, 'utf8');
      this.cachedSource = 'stored';
      return { passphrase: decrypted, source: 'stored' };
    }

    if (!this.isTTY()) {
      throw new PassphraseUnavailableError(
        'CA passphrase is unavailable: no env var, no stored blob, and stdin is not a TTY',
      );
    }
    const prompted = await this.promptForPassphrase();
    this.cache = Buffer.from(prompted, 'utf8');
    this.cachedSource = 'prompt';
    return { passphrase: prompted, source: 'prompt' };
  }

  /** Encrypt and persist `passphrase` under `<dataDir>/ca/passphrase.enc`. */
  async store(passphrase: string): Promise<void> {
    const hostKey = await this.loadOrCreateHostKey();
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const derived = crypto.pbkdf2Sync(hostKey, salt, KDF_ITERATIONS, KEY_LENGTH, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(passphrase, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob: StoredBlobV1 = {
      version: BLOB_VERSION,
      kdf: 'pbkdf2-sha256',
      iterations: KDF_ITERATIONS,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
    await fs.mkdir(path.dirname(this.passphraseBlobPath()), { recursive: true });
    await atomicWriteFile(this.passphraseBlobPath(), JSON.stringify(blob), { mode: 0o600 });
    // Re-chmod in case umask interfered.
    await fs.chmod(this.passphraseBlobPath(), 0o600);
  }

  /** Zero and drop the in-memory cache. Idempotent. */
  clear(): void {
    if (this.cache !== null) {
      this.cache.fill(0);
    }
    this.cache = null;
    this.cachedSource = null;
  }

  // --- internals ---------------------------------------------------------

  private passphraseBlobPath(): string {
    return path.join(this.dataDir, 'ca', 'passphrase.enc');
  }

  private hostKeyPath(): string {
    return path.join(this.dataDir, 'ca', 'host.key');
  }

  private async loadOrCreateHostKey(): Promise<Buffer> {
    const p = this.hostKeyPath();
    try {
      const raw = await fs.readFile(p);
      if (raw.length === HOST_KEY_LENGTH) return raw;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const fresh = crypto.randomBytes(HOST_KEY_LENGTH);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await atomicWriteFile(p, fresh, { mode: 0o600 });
    await fs.chmod(p, 0o600);
    return fresh;
  }

  private async decryptStored(blobPath: string): Promise<string> {
    const raw = await fs.readFile(blobPath, 'utf8');
    let parsed: StoredBlobV1;
    try {
      parsed = JSON.parse(raw) as StoredBlobV1;
    } catch (err) {
      throw new PassphraseUnavailableError(
        `passphrase.enc is malformed JSON: ${(err as Error).message}`,
      );
    }
    if (parsed.version !== BLOB_VERSION || parsed.kdf !== 'pbkdf2-sha256') {
      throw new PassphraseUnavailableError(
        `unsupported passphrase blob version=${parsed.version} kdf=${parsed.kdf}`,
      );
    }
    const hostKey = await this.loadOrCreateHostKey();
    const salt = Buffer.from(parsed.salt, 'hex');
    const iv = Buffer.from(parsed.iv, 'hex');
    const tag = Buffer.from(parsed.tag, 'hex');
    const ciphertext = Buffer.from(parsed.ciphertext, 'hex');
    const derived = crypto.pbkdf2Sync(hostKey, salt, parsed.iterations, KEY_LENGTH, 'sha256');
    const decipher = this.createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return out.toString('utf8');
  }

  private async promptForPassphrase(): Promise<string> {
    if (this.readlineFactory) {
      const reader = this.readlineFactory();
      try {
        return await reader.questionHidden('CA passphrase: ');
      } finally {
        reader.close();
      }
    }
    return defaultTtyPrompt('CA passphrase: ');
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default TTY prompt that suppresses local echo so the passphrase is not
 * mirrored to the screen. This is best-effort: on platforms that do not
 * support raw-mode stdin, echo may still occur.
 */
async function defaultTtyPrompt(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    let buf = '';
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          finish();
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          reject(new PassphraseUnavailableError('passphrase prompt aborted'));
          return;
        }
        if (code === 127 || code === 8) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      rl.close();
      process.stdout.write('\n');
    };
    const finish = (): void => {
      cleanup();
      resolve(buf);
    };
    process.stdout.write(prompt);
    process.stdin.on('data', onData);
  });
}
