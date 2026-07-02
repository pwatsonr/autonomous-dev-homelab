/**
 * Unraid array and pool health probes.
 * SPEC: REQ-000055 TASK-009.
 *
 * - `UnraidArrayHealthProbe`: checks the main array status via
 *   `mdcmd status` output. Emits `disk_io_error` on degraded states.
 * - `UnraidPoolHealthProbe`: checks ZFS pool health via `zpool status`.
 *   Emits `zfs_pool_degraded` on degraded/faulted pools.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface UnraidExecSource {
  exec(command: string): Promise<{ stdout: string }>;
}

// ------- Array Health -------

const MDCMD_STATUS_CMD = 'mdcmd status 2>/dev/null || true';

export class UnraidArrayHealthProbe extends BaseProbe {
  readonly id = 'unraid-array-health';
  readonly cadence = 'medium' as const;

  constructor(
    readonly platformId: string,
    private readonly src: UnraidExecSource,
  ) {
    super();
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.src.exec(MDCMD_STATUS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'unraid-array', `array/${this.platformId}`)];
    }

    const observations: Observation[] = [];
    // mdcmd status output: KEY=VALUE pairs
    const lines = raw.stdout.split('\n');
    const kvMap: Record<string, string> = {};
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      kvMap[key] = val;
    }

    const mdState = kvMap['mdState'] ?? '';
    if (mdState !== 'STARTED' && mdState !== '') {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'disk_io_error',
          resource: `array/${this.platformId}`,
          severity: mdState === 'STOPPED' ? 'P1' : 'P0',
          details: { mdState, raw: raw.stdout.slice(0, 200) },
        }),
      );
    }

    return observations;
  }
}

// ------- Pool Health -------

const ZPOOL_STATUS_CMD = 'zpool status -x 2>/dev/null || true';

export class UnraidPoolHealthProbe extends BaseProbe {
  readonly id = 'unraid-pool-health';
  readonly cadence = 'medium' as const;

  constructor(
    readonly platformId: string,
    private readonly src: UnraidExecSource,
  ) {
    super();
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.src.exec(ZPOOL_STATUS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'unraid-pool', `pool/${this.platformId}`)];
    }

    // `zpool status -x` outputs "all pools are healthy" when everything is fine
    if (/all pools are healthy/i.test(raw.stdout)) {
      return [];
    }

    // Otherwise, parse pool states
    const observations: Observation[] = [];
    const poolNameRe = /^\s*pool:\s+(\S+)/gm;
    const stateRe = /^\s*state:\s+(\S+)/gm;

    const names: string[] = [];
    const states: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = poolNameRe.exec(raw.stdout)) !== null) {
      names.push(m[1] ?? 'unknown');
    }
    while ((m = stateRe.exec(raw.stdout)) !== null) {
      states.push(m[1] ?? 'UNKNOWN');
    }

    for (let i = 0; i < names.length; i++) {
      const state = states[i] ?? 'UNKNOWN';
      if (state !== 'ONLINE') {
        observations.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'zfs_pool_degraded',
            resource: `pool/${names[i] ?? 'unknown'}`,
            severity: state === 'FAULTED' || state === 'UNAVAIL' ? 'P0' : 'P1',
            details: { pool: names[i], state },
          }),
        );
      }
    }

    return observations;
  }
}

/**
 * Factory functions matching the spec naming convention.
 */
export function unraidArrayHealthProbe(
  platformId: string,
  src?: UnraidExecSource,
): UnraidArrayHealthProbe {
  const defaultSrc: UnraidExecSource = {
    async exec(_cmd: string): Promise<{ stdout: string }> {
      return { stdout: '' };
    },
  };
  return new UnraidArrayHealthProbe(platformId, src ?? defaultSrc);
}

export function unraidPoolHealthProbe(
  platformId: string,
  src?: UnraidExecSource,
): UnraidPoolHealthProbe {
  const defaultSrc: UnraidExecSource = {
    async exec(_cmd: string): Promise<{ stdout: string }> {
      return { stdout: '' };
    },
  };
  return new UnraidPoolHealthProbe(platformId, src ?? defaultSrc);
}
