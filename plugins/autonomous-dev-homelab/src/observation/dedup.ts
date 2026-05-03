/**
 * `DedupCache`: in-memory dedup cache keyed by `<platform>:<pattern>:<resource>`
 * with a sliding 1h window. Implements SPEC-002-1-04.
 *
 * `hydrate()` is called by the collector at startup so dedup survives
 * process restarts (rehydrating from recent on-disk observations).
 */

import type { Observation } from './types.js';

const DEFAULT_WINDOW_MS = 3_600_000;

function keyOf(obs: Observation): string {
  return obs.dedup_key ?? `${obs.platform}:${obs.pattern}:${obs.resource}`;
}

export class DedupCache {
  private readonly cache = new Map<string, number>();

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  /**
   * Returns true if `obs` was seen within the window. Updates the
   * cache to mark the observation as seen at `now` either way.
   */
  isDuplicate(obs: Observation, now: number = Date.now()): boolean {
    const key = keyOf(obs);
    const last = this.cache.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return true;
    }
    this.cache.set(key, now);
    return false;
  }

  /** Pre-populate the cache from persisted observations on startup. */
  hydrate(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      const ts = new Date(obs.discovered_at).getTime();
      if (Number.isNaN(ts)) continue;
      if (now - ts < this.windowMs) {
        this.cache.set(keyOf(obs), ts);
      }
    }
  }

  /** Test seam — number of entries currently held. */
  size(): number {
    return this.cache.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }
}
