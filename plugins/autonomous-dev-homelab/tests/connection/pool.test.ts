/**
 * Unit tests for `ConnectionPool`. Implements SPEC-001-2-05
 * §"Pool Tests".
 *
 * Uses a fake clock injected via the pool's `clock` dep to avoid real
 * waiting. Reaper start/stop is tested with `jest.useFakeTimers()` so the
 * `setInterval` schedule never actually fires in real time.
 */

import { ConnectionPool } from '../../src/connection/pool';
import { Connection } from '../../src/connection/base';
import type { ExecResult } from '../../src/connection/base';

class StubConnection extends Connection {
  public connectCalls = 0;
  public disconnectCalls = 0;
  public connectError?: Error;
  public connectDelayMs = 0;

  override async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.connectDelayMs));
    }
    if (this.connectError) throw this.connectError;
    this.connected = true;
    this.capabilities = { transport: 'ssh', hostname: 'h' };
  }
  override async exec(): Promise<ExecResult> {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  }
  override async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

describe('ConnectionPool', () => {
  it('reuses live connections within idle TTL', async () => {
    let now = 1000;
    const pool = new ConnectionPool(
      { idleTimeoutMs: 60_000, maxConnections: 10 },
      (id) => new StubConnection(id),
      { clock: () => now },
    );
    const a = await pool.getConnection('p1');
    now += 100;
    const b = await pool.getConnection('p1');
    expect(b).toBe(a);
    expect(pool.size()).toBe(1);
  });

  it('reaps and re-creates after idle TTL', async () => {
    let now = 1000;
    const made: StubConnection[] = [];
    const pool = new ConnectionPool(
      { idleTimeoutMs: 5000, maxConnections: 10 },
      (id) => {
        const c = new StubConnection(id);
        made.push(c);
        return c;
      },
      { clock: () => now },
    );
    const c1 = await pool.getConnection('p1');
    now += 5001;
    await pool.reapIdle();
    const c2 = await pool.getConnection('p1');
    expect(c2).not.toBe(c1);
    expect((c1 as StubConnection).disconnectCalls).toBe(1);
    expect(made.length).toBe(2);
  });

  it('deduplicates concurrent getConnection calls (factory called once)', async () => {
    let now = 1000;
    let factoryCalls = 0;
    const pool = new ConnectionPool(
      { idleTimeoutMs: 60_000, maxConnections: 10 },
      (id) => {
        factoryCalls += 1;
        const c = new StubConnection(id);
        c.connectDelayMs = 25; // ensure all concurrent calls hit the inflight path
        return c;
      },
      { clock: () => now },
    );
    const promises = Array.from({ length: 10 }, () => pool.getConnection('p1'));
    const results = await Promise.all(promises);
    expect(factoryCalls).toBe(1);
    expect(new Set(results).size).toBe(1); // all same instance
  });

  it('evicts the LRU entry when at maxConnections', async () => {
    let now = 1000;
    const made: Record<string, StubConnection> = {};
    const pool = new ConnectionPool(
      { idleTimeoutMs: 60_000, maxConnections: 2 },
      (id) => {
        const c = new StubConnection(id);
        made[id] = c;
        return c;
      },
      { clock: () => now },
    );
    await pool.getConnection('p1');
    now += 10;
    await pool.getConnection('p2');
    now += 10;
    // Both at cap. Adding p3 should evict p1 (oldest lastUsedAt).
    await pool.getConnection('p3');
    expect(pool.size()).toBe(2);
    expect(made.p1?.disconnectCalls).toBe(1);
    expect(made.p2?.disconnectCalls).toBe(0);
    expect(made.p3?.disconnectCalls).toBe(0);
  });

  it('closeAll() disconnects every entry, tolerating per-entry failures', async () => {
    let now = 1000;
    const fail = new StubConnection('p2');
    fail.disconnect = jest.fn().mockRejectedValue(new Error('disconnect-fail'));
    const factories: Record<string, Connection> = {
      p1: new StubConnection('p1'),
      p2: fail,
      p3: new StubConnection('p3'),
    };
    const warn = jest.fn();
    const pool = new ConnectionPool(
      { idleTimeoutMs: 60_000, maxConnections: 10 },
      (id) => factories[id]!,
      { clock: () => now, logger: { warn } },
    );
    await pool.getConnection('p1');
    await pool.getConnection('p2');
    await pool.getConnection('p3');
    await expect(pool.closeAll()).resolves.toBeUndefined();
    expect(pool.size()).toBe(0);
    expect((factories.p1 as StubConnection).disconnectCalls).toBe(1);
    expect((factories.p3 as StubConnection).disconnectCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'connection_pool_disconnect_failed',
      expect.objectContaining({ platformId: 'p2' }),
    );
  });

  it('startReaper / stopReaper are idempotent', async () => {
    jest.useFakeTimers();
    try {
      const pool = new ConnectionPool(
        { idleTimeoutMs: 1000, reapIntervalMs: 500, maxConnections: 10 },
        (id) => new StubConnection(id),
      );
      pool.startReaper();
      pool.startReaper(); // should not register a second interval
      pool.stopReaper();
      pool.stopReaper(); // safe no-op
      // Can be re-started after stop
      pool.startReaper();
      pool.stopReaper();
    } finally {
      jest.useRealTimers();
    }
  });

  it('release stamps lastUsedAt forward', async () => {
    let now = 1000;
    const pool = new ConnectionPool(
      { idleTimeoutMs: 5000, maxConnections: 10 },
      (id) => new StubConnection(id),
      { clock: () => now },
    );
    await pool.getConnection('p1');
    now += 4000;
    await pool.release('p1');
    now += 4000; // total 8000ms since create, but only 4000ms since release
    await pool.reapIdle();
    expect(pool.size()).toBe(1); // still alive
  });

  it('reapIdle leaves fresh entries untouched', async () => {
    let now = 1000;
    const pool = new ConnectionPool(
      { idleTimeoutMs: 5000, maxConnections: 10 },
      (id) => new StubConnection(id),
      { clock: () => now },
    );
    await pool.getConnection('p1');
    now += 100;
    await pool.reapIdle();
    expect(pool.size()).toBe(1);
  });
});
