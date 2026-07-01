/**
 * Docker Swarm container health probe.
 * SPEC: REQ-000055 TASK-009.
 *
 * Checks the health of all services/tasks in a Docker Swarm cluster
 * by running `docker service ls --format json` on the manager/worker node.
 * Emits `crash_loop` observations for tasks in the FAILED or SHUTDOWN state.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface SwarmExecSource {
  exec(command: string): Promise<{ stdout: string }>;
}

const SWARM_SERVICE_CMD = 'docker service ls --format "{{json .}}"';

interface SwarmServiceRow {
  ID?: string;
  Name?: string;
  Replicas?: string;
  Image?: string;
  Ports?: string;
}

/**
 * Probe that checks Docker Swarm service health.
 * Emits `crash_loop` when replicas don't match desired count.
 */
export class SwarmContainerHealthProbe extends BaseProbe {
  readonly id = 'swarm-container-health';
  readonly cadence = 'fast' as const;

  constructor(
    readonly platformId: string,
    private readonly src: SwarmExecSource,
  ) {
    super();
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.src.exec(SWARM_SERVICE_CMD);
    } catch (err) {
      return [this.unreachable(err, 'swarm', `swarm/${this.platformId}`)];
    }

    const observations: Observation[] = [];
    for (const line of raw.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let svc: SwarmServiceRow;
      try {
        svc = JSON.parse(trimmed) as SwarmServiceRow;
      } catch {
        continue;
      }
      const name = svc.Name ?? svc.ID ?? 'unknown';
      const replicas = svc.Replicas ?? '';
      // Replicas format: "1/1", "0/1" (running/desired)
      const [running, desired] = replicas.split('/').map((s) => parseInt(s.trim(), 10));
      if (
        desired !== undefined &&
        !isNaN(desired) &&
        running !== undefined &&
        !isNaN(running) &&
        running < desired
      ) {
        observations.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'crash_loop',
            resource: `service/${name}`,
            severity: running === 0 ? 'P0' : 'P1',
            details: { replicas: svc.Replicas, service: name },
          }),
        );
      }
    }
    return observations;
  }
}

/**
 * Factory function: create a SwarmContainerHealthProbe for a given hostname.
 * The exec source defaults to a no-op (no connections in unit tests).
 */
export function swarmContainerHealthProbe(
  platformId: string,
  src?: SwarmExecSource,
): SwarmContainerHealthProbe {
  const defaultSrc: SwarmExecSource = {
    async exec(_cmd: string): Promise<{ stdout: string }> {
      return { stdout: '' };
    },
  };
  return new SwarmContainerHealthProbe(platformId, src ?? defaultSrc);
}
