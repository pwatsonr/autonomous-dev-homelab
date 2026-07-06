/**
 * Build live probes from the homelab config.
 * SPEC: REQ-000055 §2.11, TASK-009.
 *
 * Probe allocation:
 * - docker-swarm-manager / docker-swarm-worker → 1× swarmContainerHealthProbe
 * - unraid → 1× unraidArrayHealthProbe + 1× unraidPoolHealthProbe (in that order)
 *
 * Ordering MUST match config.hosts ordering.
 *
 * When `pool` is supplied, each probe receives a real exec source backed by
 * that host's connection from the pool. When `pool` is absent (unit tests),
 * the probe factory falls back to its own no-op default.
 */

import type { HomelabConfig } from '../config/types.js';
import type { Probe } from './types.js';
import type { ConnectionPool } from '../connection/pool.js';
import type { SwarmExecSource } from './probes/swarm.js';
import type { UnraidExecSource } from './probes/unraid-health.js';
import { swarmContainerHealthProbe } from './probes/swarm.js';
import { unraidArrayHealthProbe, unraidPoolHealthProbe } from './probes/unraid-health.js';

export interface BuildLiveProbesOptions {
  /**
   * When provided, each probe's exec source is backed by the connection for
   * that host. The pool is used lazily — `getConnection` is called only when
   * the probe's `scan()` method runs, not at construction time.
   */
  pool?: ConnectionPool;
}

/**
 * Build an exec source for a given hostname using the connection pool.
 * The pool is consulted lazily at scan time so build-time errors (e.g. host
 * not yet connected) do not prevent probe construction.
 *
 * @param hostname - The host's identifier in the connection pool.
 * @param pool - The live connection pool.
 * @returns An ExecSource that delegates to `pool.getConnection(hostname).exec`.
 */
function poolExecSource(hostname: string, pool: ConnectionPool): SwarmExecSource & UnraidExecSource {
  return {
    async exec(command: string): Promise<{ stdout: string }> {
      const conn = await pool.getConnection(hostname);
      const result = await conn.exec(command);
      return { stdout: result.stdout };
    },
  };
}

/**
 * Build the probe list from the homelab config.
 * Ordering matches config.hosts iteration order.
 *
 * @param config - The operator's homelab config (host list drives probe allocation).
 * @param opts - Optional; supply `pool` to inject live connection-backed exec sources.
 */
export function buildLiveProbes(config: HomelabConfig, opts?: BuildLiveProbesOptions): Probe[] {
  const probes: Probe[] = [];

  for (const host of config.hosts) {
    const src = opts?.pool !== undefined ? poolExecSource(host.hostname, opts.pool) : undefined;

    if (
      host.platform === 'docker-swarm-manager' ||
      host.platform === 'docker-swarm-worker'
    ) {
      probes.push(swarmContainerHealthProbe(host.hostname, src));
    } else if (host.platform === 'unraid') {
      probes.push(unraidArrayHealthProbe(host.hostname, src));
      probes.push(unraidPoolHealthProbe(host.hostname, src));
    }
  }

  return probes;
}
