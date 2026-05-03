/**
 * `AuditWriter`: HMAC-chained, append-only, NDJSON audit log.
 * SPEC-001-3-02 §"`AuditWriter` Contract".
 *
 * Each line is one `AuditEntry` (see `./types.ts`). The HMAC is taken
 * over `prev_hmac || canonical_json(entry_minus_hmac)` keyed by the
 * 32-byte audit key from `AuditKeyStore`.
 *
 * Concurrency:
 *   - All `append` calls serialize through a per-instance promise mutex
 *     so concurrent callers cannot race on `prev_hmac` / `seq`.
 *   - Cross-process correctness is bounded by the OS's `appendFile`
 *     atomicity for short writes; multi-process homelab daemons are
 *     out of scope (TDD-001 §3 deployment model).
 *
 * Recovery:
 *   - On the first `append` after construction, `prev_hmac` and
 *     `prev_seq` are recovered by tail-reading the last 4 KiB of the log.
 *   - A truncated last line (no trailing newline) raises
 *     `CorruptAuditLogError`.
 *
 * Errors:
 *   - I/O failures during append propagate as `AuditWriteError`. The
 *     mutex is always released; subsequent appends succeed once the
 *     fault clears.
 */

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { AuditKeyStore } from './key-store.js';
import {
  AuditWriteError,
  CorruptAuditLogError,
  GENESIS_PREV_HMAC,
  type AppendOpts,
  type AuditEntry,
  type AuditEventType,
} from './types.js';

const TAIL_CHUNK_BYTES = 4096;

export interface AuditWriterOptions {
  /** Absolute path to the log file (e.g. `<homelab-data>/audit.log`). */
  logPath: string;
  keyStore: AuditKeyStore;
  /** Override clock; defaults to `() => new Date()`. Test seam. */
  now?: () => Date;
  /** Override default actor (defaults to `process.env.USER` or `'unknown'`). */
  defaultActor?: string;
}

/**
 * HMAC-chained, mutex-serialized audit writer. One instance per
 * `<homelab-data>/audit.log`.
 */
export class AuditWriter {
  private readonly logPath: string;
  private readonly keyStore: AuditKeyStore;
  private readonly now: () => Date;
  private readonly defaultActor: string;
  /** Promise representing the tail of the in-flight append queue. */
  private mutexTail: Promise<void> = Promise.resolve();
  /** In-memory cache of the last entry's hmac. Null until recovered. */
  private cachedPrevHmac: string | null = null;
  /** Last persisted seq (0 means file was empty). */
  private cachedPrevSeq: number | null = null;
  /** Tracks how many appends are queued (released or pending). */
  private queueDepth = 0;

  constructor(opts: AuditWriterOptions) {
    this.logPath = path.resolve(opts.logPath);
    this.keyStore = opts.keyStore;
    this.now = opts.now ?? ((): Date => new Date());
    this.defaultActor =
      opts.defaultActor ?? (process.env['USER'] ?? process.env['LOGNAME'] ?? 'unknown');
  }

  /** Returns the path of the underlying log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /** Return the recovered (or zero) prev_hmac without doing an append. */
  async getLastHmac(): Promise<string> {
    if (this.cachedPrevHmac !== null) return this.cachedPrevHmac;
    await this.recoverState();
    return this.cachedPrevHmac ?? GENESIS_PREV_HMAC;
  }

  /** Test seam: number of in-flight (pending) appends. */
  pendingWrites(): number {
    return this.queueDepth;
  }

  /**
   * Append one entry. Computes `seq`, `timestamp`, `actor`, and the
   * HMAC; serializes against other appends; writes the JSON line to
   * disk. Returns the persisted `AuditEntry`.
   */
  async append(
    event: AuditEventType,
    payload: Record<string, unknown>,
    opts: AppendOpts = {},
  ): Promise<AuditEntry> {
    this.queueDepth++;
    const previousTail = this.mutexTail;
    let releaseSelf!: () => void;
    const ownTail = new Promise<void>((resolve) => {
      releaseSelf = resolve;
    });
    this.mutexTail = previousTail.then(() => ownTail);
    try {
      await previousTail;
    } catch {
      // Previous append rejected; we own the next slot regardless.
    }
    try {
      if (this.cachedPrevHmac === null || this.cachedPrevSeq === null) {
        await this.recoverState();
      }
      const prevHmac = this.cachedPrevHmac ?? GENESIS_PREV_HMAC;
      const prevSeq = this.cachedPrevSeq ?? 0;
      const seq = prevSeq + 1;
      const timestamp = this.now().toISOString();
      const actor = opts.actor ?? this.defaultActor;
      const platform = opts.platform === undefined ? null : opts.platform;
      // Build entry-minus-hmac in stable order; canonicalJson re-sorts so
      // the literal field order here is informational.
      const minus = { actor, event, payload, platform, seq, timestamp };
      const key = await this.keyStore.getKey();
      const hmac = crypto
        .createHmac('sha256', key)
        .update(prevHmac + canonicalJson(minus))
        .digest('hex');
      const entry: AuditEntry = { ...minus, hmac };
      const line = JSON.stringify(entry) + '\n';
      try {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        await fs.appendFile(this.logPath, line, { encoding: 'utf8' });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw new AuditWriteError(
          e.code ?? 'WRITE_FAILED',
          `failed to append audit entry to ${this.logPath}: ${e.message}`,
        );
      }
      this.cachedPrevHmac = hmac;
      this.cachedPrevSeq = seq;
      return entry;
    } finally {
      releaseSelf();
      this.queueDepth--;
    }
  }

  /**
   * Recover `prev_hmac` and `prev_seq` from the last line of the log.
   * Tails the file (last 4 KiB), finds the trailing `\n`, parses the
   * last line. Empty/missing log → genesis.
   */
  private async recoverState(): Promise<void> {
    let stat: import('node:fs').Stats | null = null;
    try {
      stat = await fs.stat(this.logPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (stat === null || stat.size === 0) {
      this.cachedPrevHmac = GENESIS_PREV_HMAC;
      this.cachedPrevSeq = 0;
      return;
    }
    const fh = await fs.open(this.logPath, 'r');
    try {
      const chunkSize = Math.min(TAIL_CHUNK_BYTES, stat.size);
      const buf = Buffer.alloc(chunkSize);
      const start = Math.max(0, stat.size - chunkSize);
      const { bytesRead } = await fh.read(buf, 0, chunkSize, start);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      if (!text.endsWith('\n')) {
        throw new CorruptAuditLogError(
          `audit log ${this.logPath} last line lacks trailing newline; refusing to recover state`,
        );
      }
      const trimmed = text.slice(0, -1);
      const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
      let parsed: Partial<AuditEntry>;
      try {
        parsed = JSON.parse(lastLine) as Partial<AuditEntry>;
      } catch (err) {
        throw new CorruptAuditLogError(
          `audit log ${this.logPath} last line is not valid JSON: ${(err as Error).message}`,
        );
      }
      if (typeof parsed.hmac !== 'string' || typeof parsed.seq !== 'number') {
        throw new CorruptAuditLogError(
          `audit log ${this.logPath} last line is missing seq/hmac fields`,
        );
      }
      this.cachedPrevHmac = parsed.hmac;
      this.cachedPrevSeq = parsed.seq;
    } finally {
      await fh.close();
    }
  }
}

/**
 * No-op stub used by callers that have not been wired with an audit
 * writer. Avoids a sea of `if (writer !== undefined)` guards in the
 * managers; tests can still inject a real writer. Calls return a
 * synthetic, never-persisted entry.
 */
export class NullAuditWriter extends AuditWriter {
  constructor() {
    // Bypass the real keyStore by giving it a dummy path; getKey()
    // is never invoked because we override append().
    super({
      logPath: '/dev/null',
      keyStore: new AuditKeyStore({ keyPath: '/dev/null' }),
    });
  }
  override async append(
    event: AuditEventType,
    payload: Record<string, unknown>,
    opts: AppendOpts = {},
  ): Promise<AuditEntry> {
    return {
      seq: 0,
      timestamp: '1970-01-01T00:00:00.000Z',
      actor: opts.actor ?? 'null',
      platform: opts.platform === undefined ? null : opts.platform,
      event,
      payload,
      hmac: '',
    };
  }
}

/** Type alias for callers that want to refer to "an optional audit writer". */
export type OptionalAuditWriter = AuditWriter | undefined;

/**
 * Best-effort emit helper: swallows errors from a missing or no-op
 * writer but surfaces real `AuditWriteError`s so callers can decide.
 * The caller is expected to `await` this; per SPEC, an audit-write
 * failure aborts the destructive operation.
 */
export async function emitAudit(
  writer: AuditWriter | undefined,
  event: AuditEventType,
  payload: Record<string, unknown>,
  opts: AppendOpts = {},
): Promise<AuditEntry | null> {
  if (writer === undefined) return null;
  return writer.append(event, payload, opts);
}
