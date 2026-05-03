/**
 * `ZFSProbe`: parses `zpool status` output via an injected exec source
 * (typically an `SshConnection` to a TrueNAS or pool host) and emits
 * `zfs_pool_degraded` observations for any pool whose `state` line is
 * not `ONLINE`. Implements SPEC-002-1-03.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface ZpoolExecSource {
  readonly platformId: string;
  exec(command: string): Promise<{ stdout: string }>;
}

const ZPOOL_STATUS_CMD = 'zpool status';
const POOL_HEADER_RE = /^\s*pool:\s+(\S+)\s*$/m;
const STATE_RE = /^\s*state:\s+(\S+)\s*$/m;

export class ZFSProbe extends BaseProbe {
  readonly id = 'zfs';
  readonly cadence = 'daily' as const;

  constructor(private readonly source: ZpoolExecSource) {
    super();
  }

  get platformId(): string {
    return this.source.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.source.exec(ZPOOL_STATUS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'zfs')];
    }

    return parseZpoolStatus(raw.stdout)
      .filter((pool) => pool.state !== 'ONLINE')
      .map((pool) =>
        this.makeObservation({
          platform: this.platformId,
          pattern: 'zfs_pool_degraded',
          resource: `pool/${pool.name}`,
          severity: 'P0',
          details: { state: pool.state, raw: pool.block },
        }),
      );
  }
}

interface ParsedPool {
  name: string;
  state: string;
  block: string;
}

/**
 * Splits `zpool status` output into per-pool blocks (`pool: <name>`
 * delimits each block) and extracts the `state:` field for each.
 */
export function parseZpoolStatus(stdout: string): ParsedPool[] {
  if (stdout.trim() === '') return [];
  const lines = stdout.split('\n');
  const headerIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (POOL_HEADER_RE.test(lines[i] ?? '')) headerIdxs.push(i);
  }
  if (headerIdxs.length === 0) return [];

  const pools: ParsedPool[] = [];
  for (let i = 0; i < headerIdxs.length; i++) {
    const start = headerIdxs[i]!;
    const end = i + 1 < headerIdxs.length ? headerIdxs[i + 1]! : lines.length;
    const block = lines.slice(start, end).join('\n');
    const nameMatch = POOL_HEADER_RE.exec(block);
    const stateMatch = STATE_RE.exec(block);
    if (!nameMatch) continue;
    pools.push({
      name: nameMatch[1] ?? 'unknown',
      state: stateMatch?.[1] ?? 'UNKNOWN',
      block,
    });
  }
  return pools;
}
