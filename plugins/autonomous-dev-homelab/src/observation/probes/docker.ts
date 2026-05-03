/**
 * `DockerProbe`: pulls the last 5 minutes of `docker events` filtered
 * for `event=oom` via a `DockerConnection` (PLAN-001-2) and emits
 * `oom_kill` observations. Implements SPEC-002-1-02.
 *
 * Uses the Go-template `{{json .}}` `--format` form rather than
 * `--format json` because some Docker versions lack the latter.
 */

import type { DockerConnection } from '../../connection/docker.js';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

interface DockerOomEvent {
  Type?: string;
  Action?: string;
  Actor: { Attributes: { name: string; image?: string } };
  time?: number;
}

const DOCKER_EVENTS_CMD =
  "docker events --since 5m --until 0m --filter event=oom --format '{{json .}}'";

export class DockerProbe extends BaseProbe {
  readonly id = 'docker';
  readonly cadence = 'fast' as const;

  constructor(private readonly conn: DockerConnection) {
    super();
  }

  get platformId(): string {
    return this.conn.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.conn.exec(DOCKER_EVENTS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'docker', `dockerd/${this.platformId}`)];
    }

    const observations: Observation[] = [];
    for (const line of raw.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let evt: DockerOomEvent;
      try {
        evt = JSON.parse(trimmed) as DockerOomEvent;
      } catch {
        // Skip malformed lines rather than failing the whole scan.
        continue;
      }
      const name = evt.Actor?.Attributes?.name;
      if (typeof name !== 'string' || name === '') continue;
      const details: Record<string, unknown> = {};
      if (evt.Actor.Attributes.image !== undefined) {
        details['image'] = evt.Actor.Attributes.image;
      }
      if (evt.time !== undefined) details['time'] = evt.time;
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'oom_kill',
          resource: `container/${name}`,
          severity: 'P1',
          details,
        }),
      );
    }
    return observations;
  }
}
