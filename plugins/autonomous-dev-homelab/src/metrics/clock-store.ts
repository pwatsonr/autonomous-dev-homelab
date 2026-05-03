/**
 * Clock store per SPEC-002-3-03.
 *
 * Persists in-flight MTTR and gate-latency clocks so daemon restarts
 * preserve elapsed-time semantics. Each clock is HMAC-signed and lives
 * under `<homelab-data>/metrics-clocks/<id>.json`.
 *
 * Same `(kind, key)` raised twice without an intervening `stop` is a
 * programming error — `start` throws `ClockAlreadyRunning`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteFile } from '../util/atomic-write.js';
import { signPayload, verifyPayload } from '../safety/hmac.js';

export type ClockKind = 'mttr' | 'gate-latency';

export interface Clock {
  id: string;
  kind: ClockKind;
  key: string;
  startedAt: number;
  metadata: Record<string, string>;
}

export interface StopResult {
  startedAt: number;
  durationMs: number;
  metadata: Record<string, string>;
}

export class ClockAlreadyRunning extends Error {
  constructor(public readonly kind: ClockKind, public readonly key: string) {
    super(`clock already running for kind=${kind} key=${key}`);
    this.name = 'ClockAlreadyRunning';
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface ClockStoreOptions {
  /** Override the data dir for tests. */
  dataDir?: string;
  /** Clock injection. */
  now?: () => number;
}

export class ClockStore {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: ClockStoreOptions = {}) {
    if (opts.dataDir !== undefined) {
      this.dir = path.join(opts.dataDir, 'metrics-clocks');
    } else {
      const fromEnv = process.env['HOMELAB_DATA_DIR'] ?? process.env['CLAUDE_PLUGIN_DATA'];
      const base = fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.resolve(process.cwd(), '.homelab-data');
      this.dir = path.join(base, 'metrics-clocks');
    }
    this.now = opts.now ?? Date.now;
  }

  async start(kind: ClockKind, key: string, metadata: Record<string, string>): Promise<string> {
    const composite = `${kind}:${key}`;
    if (!SAFE_ID.test(composite)) {
      throw new Error(`invalid clock key: ${composite}`);
    }
    const existing = await this.findByKey(kind, key);
    if (existing !== null) {
      throw new ClockAlreadyRunning(kind, key);
    }
    const id = `${kind}--${key}--${randomBytes(4).toString('hex')}`;
    const clock: Clock = {
      id,
      kind,
      key,
      startedAt: this.now(),
      metadata,
    };
    const signed = signPayload(clock);
    await atomicWriteFile(this.pathFor(id), JSON.stringify(signed));
    return id;
  }

  async stop(idOrComposite: string): Promise<StopResult | null> {
    let clock: Clock | null = null;
    if (idOrComposite.includes('--')) {
      // looks like an id — direct read.
      clock = await this.readById(idOrComposite);
    } else if (idOrComposite.includes(':')) {
      const colon = idOrComposite.indexOf(':');
      const kind = idOrComposite.slice(0, colon) as ClockKind;
      const key = idOrComposite.slice(colon + 1);
      clock = await this.findByKey(kind, key);
    }
    if (clock === null) return null;
    const stoppedAt = this.now();
    try {
      await fs.unlink(this.pathFor(clock.id));
    } catch {
      // ignore — race with another reaper
    }
    return {
      startedAt: clock.startedAt,
      durationMs: stoppedAt - clock.startedAt,
      metadata: clock.metadata,
    };
  }

  /**
   * Returns the count of clocks older than `olderThanMs`. When `olderThanMs == 0`,
   * returns the total count WITHOUT removing (dry-run / surfacing).
   */
  async purgeStale(olderThanMs: number): Promise<number> {
    const all = await this.listAll();
    if (olderThanMs === 0) return all.length;
    const threshold = this.now() - olderThanMs;
    let removed = 0;
    for (const clock of all) {
      if (clock.startedAt < threshold) {
        try {
          await fs.unlink(this.pathFor(clock.id));
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
    return removed;
  }

  async listAll(): Promise<Clock[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Clock[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      const clock = await this.readById(id);
      if (clock !== null) out.push(clock);
    }
    return out;
  }

  // -- private helpers --------------------------------------------------

  private pathFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private async readById(id: string): Promise<Clock | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.pathFor(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const signed = JSON.parse(raw) as { payload: Clock; hmac: string };
    if (!verifyPayload(signed)) return null;
    return signed.payload;
  }

  private async findByKey(kind: ClockKind, key: string): Promise<Clock | null> {
    const all = await this.listAll();
    for (const clock of all) {
      if (clock.kind === kind && clock.key === key) return clock;
    }
    return null;
  }
}
