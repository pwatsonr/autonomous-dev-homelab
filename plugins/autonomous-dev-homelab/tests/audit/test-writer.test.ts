/**
 * Comprehensive unit tests for `AuditWriter`. SPEC-001-3-05 §
 * "`test-writer.test.ts` (Unit)".
 *
 * Builds on the basic `key-store.test.ts` smoke tests. Targets ≥95%
 * line/branch coverage on `audit/writer.ts` and exercises every documented
 * behaviour:
 *   - basic append: seq monotonicity, prev_hmac chain, canonical-JSON
 *     determinism
 *   - concurrency: 1000 racing appends remain contiguous and verifiable
 *   - recovery: tail-read across new instances, missing log → genesis,
 *     truncated last line → CorruptAuditLogError
 *   - error handling: appendFile failures bubble as AuditWriteError, mutex
 *     released, payload not mutated
 *   - NullAuditWriter + emitAudit helpers
 */

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { AuditKeyStore } from '../../src/audit/key-store';
import {
  AuditWriter,
  NullAuditWriter,
  emitAudit,
} from '../../src/audit/writer';
import { canonicalJson } from '../../src/audit/canonical-json';
import {
  AuditWriteError,
  CorruptAuditLogError,
  GENESIS_PREV_HMAC,
  type AuditEntry,
} from '../../src/audit/types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface Ctx {
  dir: string;
  logPath: string;
  keyPath: string;
  keyStore: AuditKeyStore;
}

async function makeCtx(): Promise<Ctx> {
  const dir = await mkTempDir('audit-writer-');
  const logPath = path.join(dir, 'audit.log');
  const keyPath = path.join(dir, '.audit-key');
  const keyStore = new AuditKeyStore({ keyPath });
  return { dir, logPath, keyPath, keyStore };
}

function makeWriter(
  ctx: Ctx,
  overrides: Partial<{
    now: () => Date;
    defaultActor: string;
  }> = {},
): AuditWriter {
  return new AuditWriter({
    logPath: ctx.logPath,
    keyStore: ctx.keyStore,
    defaultActor: overrides.defaultActor ?? 'test-user',
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

async function readLines(logPath: string): Promise<AuditEntry[]> {
  const raw = await fs.readFile(logPath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}

describe('AuditWriter — basic', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await rmTempDir(ctx.dir);
  });

  it('first append starts at seq=1 with prev_hmac = GENESIS', async () => {
    const w = makeWriter(ctx);
    const entry = await w.append('discovery_started', { cidr: '10.0.0.0/24' });
    expect(entry.seq).toBe(1);
    // Re-derive: HMAC over GENESIS || canonical_json(entry-minus-hmac).
    const key = await ctx.keyStore.getKey();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hmac, ...minus } = entry;
    const expected = crypto
      .createHmac('sha256', key)
      .update(GENESIS_PREV_HMAC + canonicalJson(minus))
      .digest('hex');
    expect(entry.hmac).toBe(expected);
  });

  it('subsequent appends produce contiguous, chained seqs', async () => {
    const w = makeWriter(ctx);
    const a = await w.append('discovery_started', { cidr: '10.0.0.0/24' });
    const b = await w.append('discovery_completed', { exit_code: 0 });
    const c = await w.append('consent_granted', { cidr: '10.0.0.0/24' });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    // Each chains from prior.
    const key = await ctx.keyStore.getKey();
    function recompute(prev: string, e: AuditEntry): string {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hmac, ...minus } = e;
      return crypto
        .createHmac('sha256', key)
        .update(prev + canonicalJson(minus))
        .digest('hex');
    }
    expect(recompute(GENESIS_PREV_HMAC, a)).toBe(a.hmac);
    expect(recompute(a.hmac, b)).toBe(b.hmac);
    expect(recompute(b.hmac, c)).toBe(c.hmac);
  });

  it('canonical-JSON: payload field order does not change HMAC', async () => {
    const w1 = makeWriter(ctx, {
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });
    const e1 = await w1.append('connection_opened', { z: 1, a: 2, m: 3 });

    // Fresh log + same fixed clock + same key store: re-emit with payload
    // keys in a different literal order, expect identical HMAC.
    await fs.unlink(ctx.logPath);
    const w2 = makeWriter(ctx, {
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });
    const e2 = await w2.append('connection_opened', { a: 2, m: 3, z: 1 });
    expect(e2.hmac).toBe(e1.hmac);
  });

  it('platform defaults to null when not supplied', async () => {
    const w = makeWriter(ctx);
    const e = await w.append('discovery_started', { x: 1 });
    expect(e.platform).toBeNull();
  });

  it('platform null is preserved when explicit', async () => {
    const w = makeWriter(ctx);
    const e = await w.append('discovery_started', { x: 1 }, { platform: null });
    expect(e.platform).toBeNull();
  });

  it('platform string is recorded verbatim', async () => {
    const w = makeWriter(ctx);
    const e = await w.append('connection_opened', {}, { platform: 'proxmox-01' });
    expect(e.platform).toBe('proxmox-01');
  });

  it('actor falls back to defaultActor when call omits it', async () => {
    const w = makeWriter(ctx, { defaultActor: 'fixed-bot' });
    const e = await w.append('discovery_started', {});
    expect(e.actor).toBe('fixed-bot');
  });

  it('actor override on a per-call basis wins over default', async () => {
    const w = makeWriter(ctx, { defaultActor: 'fixed-bot' });
    const e = await w.append('ca_initialized', {}, { actor: 'admin-user' });
    expect(e.actor).toBe('admin-user');
  });

  it('caller-supplied payload is not mutated', async () => {
    const w = makeWriter(ctx);
    const payload = { cidr: '10.0.0.0/24', nested: { keep: true } };
    const before = JSON.parse(JSON.stringify(payload)) as typeof payload;
    await w.append('discovery_started', payload);
    expect(payload).toEqual(before);
  });

  it('getLogPath returns the resolved absolute path', async () => {
    const w = makeWriter(ctx);
    expect(w.getLogPath()).toBe(path.resolve(ctx.logPath));
  });

  it('default constructor honours USER env when defaultActor is omitted', async () => {
    const prior = process.env['USER'];
    process.env['USER'] = 'env-user';
    try {
      const w = new AuditWriter({
        logPath: ctx.logPath,
        keyStore: ctx.keyStore,
      });
      const e = await w.append('discovery_started', {});
      expect(e.actor).toBe('env-user');
    } finally {
      if (prior === undefined) delete process.env['USER'];
      else process.env['USER'] = prior;
    }
  });

  it('default constructor falls back to LOGNAME when USER is unset', async () => {
    const priorUser = process.env['USER'];
    const priorLog = process.env['LOGNAME'];
    delete process.env['USER'];
    process.env['LOGNAME'] = 'logname-user';
    try {
      const w = new AuditWriter({
        logPath: ctx.logPath,
        keyStore: ctx.keyStore,
      });
      const e = await w.append('discovery_started', {});
      expect(e.actor).toBe('logname-user');
    } finally {
      if (priorUser !== undefined) process.env['USER'] = priorUser;
      if (priorLog === undefined) delete process.env['LOGNAME'];
      else process.env['LOGNAME'] = priorLog;
    }
  });

  it('default constructor falls back to "unknown" when neither USER nor LOGNAME set', async () => {
    const priorUser = process.env['USER'];
    const priorLog = process.env['LOGNAME'];
    delete process.env['USER'];
    delete process.env['LOGNAME'];
    try {
      const w = new AuditWriter({
        logPath: ctx.logPath,
        keyStore: ctx.keyStore,
      });
      const e = await w.append('discovery_started', {});
      expect(e.actor).toBe('unknown');
    } finally {
      if (priorUser !== undefined) process.env['USER'] = priorUser;
      if (priorLog !== undefined) process.env['LOGNAME'] = priorLog;
    }
  });

  it('timestamps come from the injected clock', async () => {
    const fixed = new Date('2026-04-29T10:00:00.000Z');
    const w = makeWriter(ctx, { now: () => fixed });
    const e = await w.append('discovery_started', {});
    expect(e.timestamp).toBe('2026-04-29T10:00:00.000Z');
  });
});

describe('AuditWriter — concurrency', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await rmTempDir(ctx.dir);
  });

  it('1000 concurrent appends produce contiguous seqs and a verifiable chain', async () => {
    const w = makeWriter(ctx);
    const N = 1000;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => w.append('command_executed', { i })),
    );
    // Each entry's seq is unique and 1..N.
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // Chain on disk parses cleanly and verifies.
    const lines = await readLines(ctx.logPath);
    expect(lines).toHaveLength(N);
    expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const key = await ctx.keyStore.getKey();
    let prev = GENESIS_PREV_HMAC;
    for (const e of lines) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hmac, ...minus } = e;
      const expected = crypto
        .createHmac('sha256', key)
        .update(prev + canonicalJson(minus))
        .digest('hex');
      expect(e.hmac).toBe(expected);
      prev = e.hmac;
    }
  });

  it('pendingWrites reports a non-zero queue depth during a burst', async () => {
    const w = makeWriter(ctx);
    const seen: number[] = [];
    const burst = Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const p = w.append('command_executed', { i });
        seen.push(w.pendingWrites());
        return p;
      }),
    );
    expect(seen.some((d) => d > 1)).toBe(true);
    await burst;
    expect(w.pendingWrites()).toBe(0);
  });
});

describe('AuditWriter — recovery', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await rmTempDir(ctx.dir);
  });

  it('getLastHmac on an empty/missing log returns the GENESIS string', async () => {
    const w = makeWriter(ctx);
    expect(await w.getLastHmac()).toBe(GENESIS_PREV_HMAC);
  });

  it('a fresh instance over an existing log recovers prev_hmac via tail read', async () => {
    const w1 = makeWriter(ctx);
    await w1.append('discovery_started', { a: 1 });
    const last = await w1.append('discovery_completed', { exit_code: 0 });

    const w2 = makeWriter(ctx);
    expect(await w2.getLastHmac()).toBe(last.hmac);

    // Next append on the new instance continues the chain monotonically.
    const next = await w2.append('consent_granted', { cidr: '10.0.0.0/24' });
    expect(next.seq).toBe(3);
  });

  it('caches prev_hmac after the first recovery (subsequent calls do not re-read)', async () => {
    const w1 = makeWriter(ctx);
    const a = await w1.append('discovery_started', {});
    // First call reads from disk; second is from cache.
    const w2 = makeWriter(ctx);
    const r1 = await w2.getLastHmac();
    // Tamper the file so a re-read would change the answer.
    await fs.appendFile(ctx.logPath, '\n');
    const r2 = await w2.getLastHmac();
    expect(r1).toBe(a.hmac);
    expect(r2).toBe(a.hmac); // still cached
  });

  it('a truncated last line (no trailing newline) raises CorruptAuditLogError', async () => {
    const w1 = makeWriter(ctx);
    await w1.append('discovery_started', {});
    // Overwrite with a truncated last line.
    const raw = await fs.readFile(ctx.logPath, 'utf8');
    await fs.writeFile(ctx.logPath, raw.replace(/\n$/, ''));
    const w2 = makeWriter(ctx);
    await expect(w2.getLastHmac()).rejects.toBeInstanceOf(CorruptAuditLogError);
  });

  it('a recovered file with non-JSON last line raises CorruptAuditLogError', async () => {
    await fs.writeFile(ctx.logPath, 'not-json\n');
    const w = makeWriter(ctx);
    await expect(w.getLastHmac()).rejects.toBeInstanceOf(CorruptAuditLogError);
  });

  it('a recovered file with JSON missing seq/hmac raises CorruptAuditLogError', async () => {
    await fs.writeFile(ctx.logPath, JSON.stringify({ event: 'x' }) + '\n');
    const w = makeWriter(ctx);
    await expect(w.getLastHmac()).rejects.toBeInstanceOf(CorruptAuditLogError);
  });

  it('if the file is missing, the next append starts at seq=1 (file recreated)', async () => {
    const w1 = makeWriter(ctx);
    await w1.append('discovery_started', {});
    await fs.unlink(ctx.logPath);
    const w2 = makeWriter(ctx);
    const e = await w2.append('discovery_started', {});
    expect(e.seq).toBe(1);
  });

  it('if the file is empty (size 0), recovery returns GENESIS', async () => {
    await fs.writeFile(ctx.logPath, '');
    const w = makeWriter(ctx);
    expect(await w.getLastHmac()).toBe(GENESIS_PREV_HMAC);
    const e = await w.append('discovery_started', {});
    expect(e.seq).toBe(1);
  });
});

describe('AuditWriter — error handling', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await makeCtx();
  });

  afterEach(async () => {
    await rmTempDir(ctx.dir);
  });

  it('a failure during appendFile propagates as AuditWriteError; mutex is released', async () => {
    const w = makeWriter(ctx);
    // Make the log path a directory so appendFile fails with EISDIR.
    await fs.mkdir(ctx.logPath, { recursive: true });
    await expect(
      w.append('discovery_started', { x: 1 }),
    ).rejects.toBeInstanceOf(AuditWriteError);

    // Replace with a writable file: subsequent appends succeed; mutex did
    // not deadlock.
    await fs.rm(ctx.logPath, { recursive: true, force: true });
    const e = await w.append('discovery_completed', {});
    // We cannot guarantee seq value here because cachedPrevSeq may be set
    // from a partial recovery — assert on chain integrity only.
    expect(typeof e.seq).toBe('number');
    expect(typeof e.hmac).toBe('string');
    expect(e.hmac).toHaveLength(64);
  });

  it('AuditWriteError carries an error code (e.g., EISDIR)', async () => {
    const w = makeWriter(ctx);
    await fs.mkdir(ctx.logPath, { recursive: true });
    try {
      await w.append('discovery_started', {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AuditWriteError);
      const code = (err as AuditWriteError).code;
      expect(typeof code).toBe('string');
      expect(code).not.toBe('');
    } finally {
      await fs.rm(ctx.logPath, { recursive: true, force: true });
    }
  });
});

describe('NullAuditWriter + emitAudit', () => {
  it('NullAuditWriter.append returns a synthetic entry, never persists', async () => {
    const w = new NullAuditWriter();
    const e = await w.append('discovery_started', { x: 1 });
    expect(e.seq).toBe(0);
    expect(e.hmac).toBe('');
    expect(e.actor).toBe('null');
    expect(e.platform).toBeNull();
  });

  it('NullAuditWriter respects the actor + platform overrides', async () => {
    const w = new NullAuditWriter();
    const e = await w.append('connection_opened', {}, { actor: 'admin', platform: 'p1' });
    expect(e.actor).toBe('admin');
    expect(e.platform).toBe('p1');
  });

  it('emitAudit returns null when the writer is undefined', async () => {
    const out = await emitAudit(undefined, 'discovery_started', { x: 1 });
    expect(out).toBeNull();
  });

  it('emitAudit forwards to the writer and returns its entry', async () => {
    const ctx = await makeCtx();
    try {
      const w = makeWriter(ctx);
      const out = await emitAudit(w, 'discovery_started', { x: 1 });
      expect(out).not.toBeNull();
      expect(out!.seq).toBe(1);
    } finally {
      await rmTempDir(ctx.dir);
    }
  });
});
