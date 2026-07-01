/**
 * Build live probes from the homelab config.
 * SPEC: REQ-000055 §2.11, TASK-009.
 *
 * Probe allocation:
 * - docker-swarm-manager / docker-swarm-worker → 1× swarmContainerHealthProbe
 * - unraid → 1× unraidArrayHealthProbe + 1× unraidPoolHealthProbe (in that order)
 *
 * Ordering MUST match config.hosts ordering.
 */

import type { HomelabConfig } from '../config/types.js';
import type { Probe } from './types.js';
import { swarmContainerHealthProbe } from './probes/swarm.js';
import { unraidArrayHealthProbe, unraidPoolHealthProbe } from './probes/unraid-health.js';

/**
 * Build the probe list from the homelab config.
 * Ordering matches config.hosts iteration order.
 */
export function buildLiveProbes(config: HomelabConfig): Probe[] {
  const probes: Probe[] = [];

  for (const host of config.hosts) {
    if (
      host.platform === 'docker-swarm-manager' ||
      host.platform === 'docker-swarm-worker'
    ) {
      probes.push(swarmContainerHealthProbe(host.hostname));
    } else if (host.platform === 'unraid') {
      probes.push(unraidArrayHealthProbe(host.hostname));
      probes.push(unraidPoolHealthProbe(host.hostname));
    }
  }

  return probes;
}
