/**
 * SPEC-002-1-04 — ObservationStore tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ObservationStore, RETENTION_DAYS } from '../../src/observation/persistence';
import type { Observation } from '../../src/observation/types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const ISO = '2026-05-01T00:00:00.000Z';

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    platform: overrides.platform ?? 'k3s-01',
    pattern: overrides.pattern ?? 'oom_kill',
    resource: overrides.resource ?? 'Pod/web-7c',
    severity: overrides.severity ?? 'P1',
    discovered_at: overrides.discovered_at ?? ISO,
    ...(overrides.details !== undefined ? { details: overrides.details } : {}),
    ...(overrides.dedup_key !== undefined ? { dedup_key: overrides.dedup_key } : {}),
  };
}

describe('ObservationStore', () => {
  let dataDir: string;
  let store: ObservationStore;
  beforeEach(async () => {
    dataDir = await mkTempDir('obs-store-');
    store = new ObservationStore(dataDir);
  });
  afterEach(async () => {
    await rmTempDir(dataDir);
  });

  test('save persists and load round-trips byte-for-byte under JSON.parse', async () => {
    const o = obs({ details: { count: 3 } });
    const finalPath = await store.save(o);
    expect(finalPath).toBe(path.join(dataDir, 'observations', `${o.id}.json`));
    const back = await store.load(o.id);
    expect(back).toEqual(o);
  });

  test('save uses atomic temp + rename (no .tmp file lingers)', async () => {
    const o = obs();
    await store.save(o);
    const dir = path.join(dataDir, 'observations');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
    expect(files.some((f) => f === `${o.id}.json`)).toBe(true);
  });

  test('list returns [] when directory does not exist', async () => {
    expect(await store.list()).toEqual([]);
  });

  test('list returns observations sorted newest-first', async () => {
    await store.save(
      obs({ id: '11111111-1111-4111-8111-111111111111', discovered_at: '2026-05-01T00:00:00.000Z' }),
    );
    await store.save(
      obs({ id: '22222222-2222-4222-8222-222222222222', discovered_at: '2026-05-02T00:00:00.000Z' }),
    );
    await store.save(
      obs({ id: '33333333-3333-4333-8333-333333333333', discovered_at: '2026-05-03T00:00:00.000Z' }),
    );
    const list = await store.list();
    expect(list.map((o) => o.discovered_at)).toEqual([
      '2026-05-03T00:00:00.000Z',
      '2026-05-02T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
  });

  test('list filters by since (inclusive)', async () => {
    await store.save(obs({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', discovered_at: '2026-05-01T00:00:00.000Z' }));
    await store.save(obs({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', discovered_at: '2026-05-03T00:00:00.000Z' }));
    const list = await store.list({ since: new Date('2026-05-02T00:00:00.000Z') });
    expect(list).toHaveLength(1);
    expect(list[0]!.discovered_at).toBe('2026-05-03T00:00:00.000Z');
  });

  test('list filters by platform AND severity (AND semantics)', async () => {
    await store.save(obs({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', platform: 'k3s-01', severity: 'P0' }));
    await store.save(obs({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', platform: 'k3s-01', severity: 'P1' }));
    await store.save(obs({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', platform: 'pve-01', severity: 'P0' }));
    const list = await store.list({ platform: 'k3s-01', severity: 'P0' });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  test('cleanup removes files older than 90 days, keeps newer ones', async () => {
    const oldId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const freshId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await store.save(obs({ id: oldId }));
    await store.save(obs({ id: freshId }));
    const oldPath = path.join(dataDir, 'observations', `${oldId}.json`);
    // Set mtime > 91 days ago
    const old = Date.now() - (RETENTION_DAYS + 1) * 86_400_000;
    await fs.utimes(oldPath, old / 1000, old / 1000);
    const removed = await store.cleanup();
    expect(removed).toBe(1);
    const remaining = await fs.readdir(path.join(dataDir, 'observations'));
    expect(remaining).toEqual([`${freshId}.json`]);
  });

  test('cleanup returns 0 when directory is missing', async () => {
    expect(await store.cleanup()).toBe(0);
  });

  test('list skips malformed JSON files without aborting', async () => {
    const dir = path.join(dataDir, 'observations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'broken.json'), 'not-json', 'utf8');
    await store.save(obs());
    const list = await store.list();
    expect(list).toHaveLength(1);
  });
});
