/**
 * `DaemonHeartbeatProbe`: monitors `<autonomous-dev-data>/daemon-heartbeat.json`
 * and emits a `daemon_heartbeat_stale` observation if the heartbeat is
 * older than 5 minutes (or the file is missing). Implements
 * SPEC-002-1-03.
 *
 * The heartbeat-file path is injected via constructor.
 */

import { promises as fs } from 'node:fs';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

const STALE_THRESHOLD_MS = 5 * 60_000;

export interface DaemonHeartbeatProbeOptions {
  platformId: string;
  /** Absolute path to the heartbeat JSON file. */
  heartbeatPath: string;
  /** Test seam; defaults to `() => Date.now()`. */
  now?: () => number;
}

interface HeartbeatFile {
  last_beat?: string;
  pid?: number;
}

export class DaemonHeartbeatProbe extends BaseProbe {
  readonly id = 'daemon-heartbeat';
  readonly cadence = 'fast' as const;
  readonly platformId: string;

  private readonly heartbeatPath: string;
  private readonly now: () => number;

  constructor(opts: DaemonHeartbeatProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.heartbeatPath = opts.heartbeatPath;
    this.now = opts.now ?? ((): number => Date.now());
  }

  async scan(): Promise<Observation[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.heartbeatPath, 'utf8');
    } catch {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: 'daemon_heartbeat_stale',
          resource: 'daemon/autonomous-dev',
          severity: 'P0',
          details: {
            last_beat: null,
            age_seconds: Number.POSITIVE_INFINITY,
            reason: 'heartbeat_missing',
          },
        }),
      ];
    }
    let parsed: HeartbeatFile;
    try {
      parsed = JSON.parse(raw) as HeartbeatFile;
    } catch (err) {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: 'daemon_heartbeat_stale',
          resource: 'daemon/autonomous-dev',
          severity: 'P0',
          details: {
            last_beat: null,
            age_seconds: Number.POSITIVE_INFINITY,
            reason: 'heartbeat_unparseable',
            error: String(err),
          },
        }),
      ];
    }
    const lastBeatMs = parsed.last_beat ? Date.parse(parsed.last_beat) : Number.NaN;
    if (Number.isNaN(lastBeatMs)) {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: 'daemon_heartbeat_stale',
          resource: 'daemon/autonomous-dev',
          severity: 'P0',
          details: {
            last_beat: parsed.last_beat ?? null,
            age_seconds: Number.POSITIVE_INFINITY,
            reason: 'heartbeat_invalid_timestamp',
          },
        }),
      ];
    }
    const ageMs = this.now() - lastBeatMs;
    if (ageMs > STALE_THRESHOLD_MS) {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: 'daemon_heartbeat_stale',
          resource: 'daemon/autonomous-dev',
          severity: 'P0',
          details: {
            last_beat: parsed.last_beat,
            age_seconds: Math.floor(ageMs / 1000),
          },
        }),
      ];
    }
    return [];
  }
}
