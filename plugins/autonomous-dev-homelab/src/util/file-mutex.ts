/**
 * Per-path in-process mutex. Implements SPEC-001-1-03 §"File Mutex".
 *
 * Concurrent `acquire(path)` calls on the same path serialize via a chain
 * of promises. Cross-process serialization is out of scope for v1
 * (TDD-001 §3 deployment model: one daemon per host).
 *
 * Usage:
 *   const release = await mutex.acquire(path);
 *   try { await mutate(path); } finally { release(); }
 */

export interface FileMutex {
  acquire(path: string): Promise<() => void>;
}

export function fileMutex(): FileMutex {
  // Each path's chain points at the latest pending release-promise. New
  // acquirers `await previous` then chain themselves on. When a release
  // function runs, the next waiter in line resolves and proceeds.
  const chains = new Map<string, Promise<void>>();

  return {
    async acquire(path: string): Promise<() => void> {
      const previous = chains.get(path) ?? Promise.resolve();
      let release!: () => void;
      const own = new Promise<void>((resolve) => {
        release = resolve;
      });
      chains.set(path, previous.then(() => own));
      await previous;
      return () => {
        release();
        // Best-effort cleanup: if no one else is queued behind us, drop
        // the entry to avoid unbounded growth on long-lived processes.
        // We can't reliably detect "no waiters" without reference checks
        // that race with new acquirers, so leave the entry in place; the
        // map's footprint is bounded by the set of distinct paths ever
        // mutated, which is small for inventory/consent files.
      };
    },
  };
}
