/**
 * `SMARTProbe`: enumerates block devices via `lsblk` then runs
 * `smartctl --all /dev/<device>` for each. Emits `disk_io_error`
 * observations when reallocated/pending sector counts are non-zero or
 * the overall-health line is not `PASSED`. Implements SPEC-002-1-03.
 *
 * Per-device errors are NOT fatal — only an `lsblk` enumeration
 * failure produces the unreachable sentinel.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface SmartExecSource {
  readonly platformId: string;
  exec(command: string): Promise<{ stdout: string }>;
}

const LSBLK_CMD = 'lsblk -dn -o NAME';
const ATTR_LINE_RE = /^\s*(\d+)\s+(\S+)\s+.*?(\d+)\s*$/;
const HEALTH_RE = /SMART overall-health self-assessment test result:\s+(\S+)/i;

interface SmartDeviceFinding {
  device: string;
  reallocated: number;
  pending: number;
  overall_health: string;
}

export class SMARTProbe extends BaseProbe {
  readonly id = 'smart';
  readonly cadence = 'daily' as const;

  constructor(private readonly source: SmartExecSource) {
    super();
  }

  get platformId(): string {
    return this.source.platformId;
  }

  async scan(): Promise<Observation[]> {
    let lsblk: { stdout: string };
    try {
      lsblk = await this.source.exec(LSBLK_CMD);
    } catch (err) {
      return [this.unreachable(err, 'smart')];
    }

    const devices = lsblk.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const out: Observation[] = [];
    for (const dev of devices) {
      let smart: { stdout: string };
      try {
        smart = await this.source.exec(`smartctl --all /dev/${dev}`);
      } catch {
        // Per-device error: skip, do NOT abort the whole scan.
        continue;
      }
      const finding = parseSmartctl(dev, smart.stdout);
      if (
        finding.reallocated > 0 ||
        finding.pending > 0 ||
        (finding.overall_health !== 'PASSED' && finding.overall_health !== 'UNKNOWN')
      ) {
        out.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'disk_io_error',
            resource: `disk/${this.platformId}:${dev}`,
            severity: 'P0',
            details: {
              reallocated: finding.reallocated,
              pending: finding.pending,
              overall_health: finding.overall_health,
            },
          }),
        );
      }
    }
    return out;
  }
}

export function parseSmartctl(device: string, stdout: string): SmartDeviceFinding {
  let reallocated = 0;
  let pending = 0;
  for (const line of stdout.split('\n')) {
    const m = ATTR_LINE_RE.exec(line);
    if (!m) continue;
    const id = Number.parseInt(m[1] ?? '0', 10);
    const raw = Number.parseInt(m[3] ?? '0', 10);
    if (id === 5) reallocated = raw;
    else if (id === 197) pending = raw;
  }
  const healthMatch = HEALTH_RE.exec(stdout);
  const overall_health = healthMatch?.[1] ?? 'UNKNOWN';
  return { device, reallocated, pending, overall_health };
}
