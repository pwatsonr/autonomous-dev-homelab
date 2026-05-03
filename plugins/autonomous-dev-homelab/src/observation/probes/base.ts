/**
 * Shared scaffolding for every probe in SPEC-002-1-02 / SPEC-002-1-03.
 *
 * Provides UUID generation, ISO timestamping, dedup-key construction,
 * and the canonical "platform unreachable" sentinel observation reused
 * by every probe's connection-error branch.
 */

import { randomUUID } from 'node:crypto';
import type { Observation, Probe } from '../types.js';

export abstract class BaseProbe implements Probe {
  abstract readonly id: string;
  abstract readonly platformId: string;
  abstract readonly cadence: Probe['cadence'];

  abstract scan(): Promise<Observation[]>;

  /**
   * Build a fully-formed `Observation` from a probe's structured
   * payload. Stamps `id`, `discovered_at`, and `dedup_key`.
   */
  protected makeObservation(
    input: Omit<Observation, 'id' | 'discovered_at' | 'dedup_key'>,
  ): Observation {
    const obs: Observation = {
      id: randomUUID(),
      discovered_at: new Date().toISOString(),
      dedup_key: `${input.platform}:${input.pattern}:${input.resource}`,
      platform: input.platform,
      pattern: input.pattern,
      resource: input.resource,
      severity: input.severity,
    };
    if (input.details !== undefined) obs.details = input.details;
    return obs;
  }

  /**
   * Canonical "platform unreachable" sentinel. Every probe converts a
   * thrown connection error into a single P0 `daemon_heartbeat_stale`
   * observation rather than re-throwing, so the collector loop never
   * dies on a transient outage.
   */
  protected unreachable(err: unknown, probeId: string, resource?: string): Observation {
    return this.makeObservation({
      platform: this.platformId,
      pattern: 'daemon_heartbeat_stale',
      resource: resource ?? `${probeId}/${this.platformId}`,
      severity: 'P0',
      details: { error: String(err), probe: probeId, reason: 'platform_unreachable' },
    });
  }
}
