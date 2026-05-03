/**
 * SPEC-002-1-04 — DedupCache tests.
 */

import { DedupCache } from '../../src/observation/dedup';
import type { Observation } from '../../src/observation/types';

function obs(key: string, when = '2026-05-01T00:00:00.000Z'): Observation {
  return {
    id: 'irrelevant',
    platform: 'k3s-01',
    pattern: 'oom_kill',
    resource: 'Pod/x',
    severity: 'P1',
    discovered_at: when,
    dedup_key: key,
  };
}

describe('DedupCache', () => {
  test('first sighting → not duplicate; second within 1h → duplicate', () => {
    const cache = new DedupCache();
    const t0 = 1_700_000_000_000;
    const o = obs('k3s-01:oom_kill:Pod/x');
    expect(cache.isDuplicate(o, t0)).toBe(false);
    expect(cache.isDuplicate(o, t0 + 30 * 60_000)).toBe(true);
  });

  test('after 1h + 1ms → no longer duplicate', () => {
    const cache = new DedupCache();
    const t0 = 1_700_000_000_000;
    const o = obs('k3s-01:oom_kill:Pod/x');
    cache.isDuplicate(o, t0);
    expect(cache.isDuplicate(o, t0 + 3_600_000 + 1)).toBe(false);
  });

  test('different dedup_keys are independent', () => {
    const cache = new DedupCache();
    const t0 = 1_700_000_000_000;
    expect(cache.isDuplicate(obs('a'), t0)).toBe(false);
    expect(cache.isDuplicate(obs('b'), t0)).toBe(false);
    expect(cache.isDuplicate(obs('a'), t0 + 1)).toBe(true);
  });

  test('falls back to platform:pattern:resource when dedup_key absent', () => {
    const cache = new DedupCache();
    const o: Observation = {
      id: '1',
      platform: 'k3s-01',
      pattern: 'oom_kill',
      resource: 'Pod/x',
      severity: 'P1',
      discovered_at: '2026-05-01T00:00:00.000Z',
    };
    expect(cache.isDuplicate(o, 1)).toBe(false);
    expect(cache.isDuplicate(o, 2)).toBe(true);
  });

  test('hydrate populates the cache for recent observations only', () => {
    const cache = new DedupCache();
    const now = 1_700_000_000_000;
    const recent = obs('recent', new Date(now - 30 * 60_000).toISOString());
    const stale = obs('stale', new Date(now - 2 * 3_600_000).toISOString());
    cache.hydrate([recent, stale], now);
    expect(cache.size()).toBe(1);
    expect(cache.isDuplicate(obs('recent'), now)).toBe(true);
    expect(cache.isDuplicate(obs('stale'), now)).toBe(false);
  });

  test('hydrate skips observations with NaN timestamps', () => {
    const cache = new DedupCache();
    const bad = obs('x');
    bad.discovered_at = 'not-a-date';
    cache.hydrate([bad], 1);
    expect(cache.size()).toBe(0);
  });
});
