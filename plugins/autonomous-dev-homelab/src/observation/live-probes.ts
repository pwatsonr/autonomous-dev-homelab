/**
 * Build live probes from the homelab config.
 * SPEC: REQ-000055 §2.11, TASK-009.
 *
 * Probe allocation:
 * - docker-swarm-manager / docker-swarm-worker → 1× swarmContainerHealthProbe
 * - unraid → 1× unraidArrayHealthProbe + 1× unraidPoolHealthProbe (in that order)
 * - When `alertProbe` is supplied, it is appended after host probes (issue #37).
 * - When `datastoreHealthProbe` is supplied, it is appended after alertProbe (issue #43).
 * - When `capacityProbe` is supplied, it is appended after datastoreHealthProbe (issue #44).
 * - When `policyDriftProbe` is supplied, it is appended last (issue #35).
 *
 * Ordering MUST match config.hosts ordering, with alertProbe, datastoreHealthProbe,
 * capacityProbe, then policyDriftProbe appended last.
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
  /**
   * Optional capacity probe (issue #44, invariant #62). When provided, it is
   * appended to the probe list after the datastore health probe. The probe
   * enumerates all capacity-bearing entities from the graph (storage-array,
   * storage-disk, share, datastore, pool) and emits capacity_warning /
   * capacity_critical / capacity_growth observations. Constructed by the caller
   * with a graph store + pool-backed exec source. Omitted when the graph store
   * is unavailable.
   */
  capacityProbe?: Probe;
  /**
   * Optional policy-drift probe (issue #35, invariant #62). When provided, it
   * is appended last. The probe generates the homelab policy from the live
   * graph, evaluates the actual service placement against placement and
   * anti-affinity rules, and emits `policy_drift` observations for violations.
   * Constructed by the caller with a graph store. Omitted when the graph store
   * is unavailable.
   */
  policyDriftProbe?: Probe;
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
 * Ordering matches config.hosts iteration order, with alertProbe,
 * datastoreHealthProbe, capacityProbe, then policyDriftProbe appended last.
 *
 * @param config - The operator's homelab config (host list drives probe allocation).
 * @param opts - Optional; supply `pool` to inject live connection-backed exec sources,
 *               `alertProbe` to include the Prometheus/Alertmanager probe (issue #37),
 *               `datastoreHealthProbe` to include the datastore health probe (#43),
 *               `capacityProbe` for capacity observations (#44), and/or
 *               `policyDriftProbe` for placement drift observations (#35).
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

  // Append the datastore health probe when provided (issue #43).
  // The probe reads from the graph store and uses the pool-backed exec source
  // that was injected at construction time.
  if (opts?.datastoreHealthProbe !== undefined) {
    probes.push(opts.datastoreHealthProbe);
  }

  // Append the capacity probe after datastore health when provided (issue #44).
  // The probe enumerates all capacity-bearing graph entities and emits
  // fill-ratio + growth-rate observations. Appended after datastore health
  // so the collector runs storage-health checks before capacity checks.
  if (opts?.capacityProbe !== undefined) {
    probes.push(opts.capacityProbe);
  }

  // Append the policy-drift probe last when provided (issue #35).
  // The probe generates the homelab policy from the live graph and evaluates
  // actual service placement against placement and affinity rules, emitting
  // policy_drift observations for any violations. Appended after capacity so
  // structural (drift) checks run after operational (capacity) ones.
  if (opts?.policyDriftProbe !== undefined) {
    probes.push(opts.policyDriftProbe);
  }

  return probes;
}
