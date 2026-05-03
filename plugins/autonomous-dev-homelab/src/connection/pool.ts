/**
 * `ConnectionPool`: caches open `Connection` instances across exec calls,
 * with idle TTL, capacity cap, LRU eviction, and a periodic reaper.
 * Implements SPEC-001-2-03 §"`src/connection/pool.ts`".
 *
 * Concurrency notes:
 * - Concurrent `getConnection(id)` calls before the first `connect()`
 *   resolves are deduplicated via a per-id in-flight promise map. All
 *   callers receive the same instance and `connect()` is invoked once.
 * - Eviction is strict LRU on `lastUsedAt` (set by callers via the
 *   Connection's own bookkeeping; the pool also stamps it on hand-out).
 */

import type { Connection } from './base.js';

export interface ConnectionPoolOptions {
  idleTimeoutMs?: number;
  maxConnections?: number;
  reapIntervalMs?: number;
}

export interface ConnectionPoolLogger {
  debug?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
}

export type PoolConnectionFactory = (platformId: string) => Connection;

interface PoolEntry {
  conn: Connection;
  /** Last hand-out time stamped by the pool (separate from Connection's own). */
  lastUsedAt: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONNECTIONS = 50;
const DEFAULT_REAP_INTERVAL_MS = 30 * 1000;

const NULL_LOGGER: ConnectionPoolLogger = {};

export class ConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly inflight = new Map<string, Promise<Connection>>();
  private readonly factory: PoolConnectionFactory;
  private readonly idleTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly reapIntervalMs: number;
  private readonly logger: ConnectionPoolLogger;
  private reaperHandle?: ReturnType<typeof setInterval>;
  private readonly clock: () => number;

  constructor(
    opts: ConnectionPoolOptions,
    factory: PoolConnectionFactory,
    deps: { logger?: ConnectionPoolLogger; clock?: () => number } = {},
  ) {
    this.factory = factory;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.reapIntervalMs = opts.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.logger = deps.logger ?? NULL_LOGGER;
    this.clock = deps.clock ?? (() => Date.now());
  }

  size(): number {
    return this.entries.size;
  }

  async getConnection(platformId: string): Promise<Connection> {
    const existing = this.entries.get(platformId);
    if (existing !== undefined && !this.isStale(existing)) {
      existing.lastUsedAt = this.clock();
      return existing.conn;
    }
    // If a stale entry exists, evict it first so a fresh one is created.
    if (existing !== undefined) {
      await this.evict(platformId);
    }
    const inflight = this.inflight.get(platformId);
    if (inflight !== undefined) {
      return inflight;
    }
    const promise = this.createAndConnect(platformId);
    this.inflight.set(platformId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(platformId);
    }
  }

  async release(platformId: string): Promise<void> {
    // v1 no-op; reaper handles idle cleanup. Exposed for symmetry and
    // future eager-close callers.
    const entry = this.entries.get(platformId);
    if (entry !== undefined) {
      entry.lastUsedAt = this.clock();
    }
  }

  async closeAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      this.entries.delete(id);
      try {
        await entry.conn.disconnect();
      } catch (err) {
        this.logger.warn?.('connection_pool_disconnect_failed', {
          platformId: id,
          error: (err as Error).message,
        });
      }
    }
  }

  startReaper(): void {
    if (this.reaperHandle !== undefined) return;
    this.reaperHandle = setInterval(() => {
      void this.reapIdle();
    }, this.reapIntervalMs);
    this.reaperHandle.unref?.();
  }

  stopReaper(): void {
    if (this.reaperHandle === undefined) return;
    clearInterval(this.reaperHandle);
    this.reaperHandle = undefined;
  }

  /** Test seam: synchronously sweep idle entries. */
  async reapIdle(): Promise<void> {
    const ids = [...this.entries.keys()];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      if (this.isStale(entry)) {
        await this.evict(id);
      }
    }
  }

  private isStale(entry: PoolEntry): boolean {
    return this.clock() - entry.lastUsedAt > this.idleTimeoutMs;
  }

  private async createAndConnect(platformId: string): Promise<Connection> {
    if (this.entries.size >= this.maxConnections) {
      await this.evictLRU();
    }
    const conn = this.factory(platformId);
    await conn.connect();
    this.entries.set(platformId, { conn, lastUsedAt: this.clock() });
    return conn;
  }

  private async evict(platformId: string): Promise<void> {
    const entry = this.entries.get(platformId);
    if (entry === undefined) return;
    this.entries.delete(platformId);
    try {
      await entry.conn.disconnect();
    } catch (err) {
      this.logger.warn?.('connection_pool_disconnect_failed', {
        platformId,
        error: (err as Error).message,
      });
    }
  }

  private async evictLRU(): Promise<void> {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      await this.evict(oldestId);
    }
  }
}
