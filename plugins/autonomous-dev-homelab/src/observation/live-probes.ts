/**
 * Build live probes from the homelab config.
 * SPEC: REQ-000055 §2.11, TASK-009.
 *
 * Probe allocation:
 * - docker-swarm-manager / docker-swarm-worker → 1× swarmContainerHealthProbe
 * - unraid → 1× unraidArrayHealthProbe + 1× unraidPoolHealthProbe (in that order)
 * - When `alertProbe` is supplied, it is appended after host probes (issue #37).
 * - When `datastoreHealthProbe` is supplied, it is appended last (issue #43).
 *
 * Ordering MUST match config.hosts ordering, with alertProbe then datastoreHealthProbe
 * appended last.
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
import type { AlertProbe } from './probes/alert.js';
import { swarmContainerHealthProbe } from './probes/swarm.js';
import { unraidArrayHealthProbe, unraidPoolHealthProbe } from './probes/unraid-health.js';

export interface BuildLiveProbesOptions {
  /**
   * When provided, each probe's exec source is backed by the connection for
   * that host. The pool is used lazily — `getConnection` is called only when
   * the probe's `scan()` method runs, not at construction time.
   */
  pool?: ConnectionPool;
  /**
   * When provided, the alert probe is appended to the probe list (issue #37).
   * The probe is constructed by the caller so bootstrap code can inject the
   * HTTP source and graph store without coupling this module to a specific
   * implementation.
   */
  alertProbe?: AlertProbe;
  /**
   * Optional datastore health probe (issue #43). When provided, it is
   * appended to the probe list after all host probes (and after alertProbe).
   * The probe's `scan()` reads `kind='datastore'` entities from the graph
   * store and emits health observations. Omitted when the graph store is
   * unavailable.
   */
  datastoreHealthProbe?: Probe;
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
 * Ordering matches config.hosts iteration order, with alertProbe then
 * datastoreHealthProbe appended last.
 *
 * @param config - The operator's homelab config (host list drives probe allocation).
 * @param opts - Optional; supply `pool` to inject live connection-backed exec sources,
 *               `alertProbe` to include the Prometheus/Alertmanager probe (issue #37),
 *               and/or `datastoreHealthProbe` to include the datastore health probe (#43).
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

  // Append the alert probe when provided (issue #37).
  if (opts?.alertProbe !== undefined) {
    probes.push(opts.alertProbe);
  }

  // Append the datastore health probe last when provided (issue #43).
  // The probe reads from the graph store and uses the pool-backed exec source
  // that was injected at construction time.
  if (opts?.datastoreHealthProbe !== undefined) {
    probes.push(opts.datastoreHealthProbe);
  }

  return probes;
}
