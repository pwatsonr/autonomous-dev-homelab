/**
 * `ProxmoxProbe`: queries `pvesh get /cluster/status -output-format json`
 * via a `ProxmoxConnection` (PLAN-001-2) and emits observations for
 * offline nodes and degraded storage. Implements SPEC-002-1-03.
 */

import type { ProxmoxConnection } from '../../connection/proxmox.js';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

const PVESH_CLUSTER_STATUS_CMD =
  'pvesh get /cluster/status -output-format json';

interface PveNodeEntry {
  type: 'node';
  name: string;
  online?: number;
}
interface PveStorageEntry {
  type: 'storage';
  storage: string;
  status?: string;
}
type PveStatusEntry = PveNodeEntry | PveStorageEntry | { type: string; [k: string]: unknown };

export class ProxmoxProbe extends BaseProbe {
  readonly id = 'proxmox';
  readonly cadence = 'medium' as const;

  constructor(private readonly conn: ProxmoxConnection) {
    super();
  }

  get platformId(): string {
    return this.conn.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.conn.exec(PVESH_CLUSTER_STATUS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'proxmox')];
    }

    let entries: PveStatusEntry[];
    try {
      const parsed = JSON.parse(raw.stdout) as unknown;
      entries = Array.isArray(parsed) ? (parsed as PveStatusEntry[]) : [];
    } catch (err) {
      return [this.unreachable(err, 'proxmox')];
    }

    const out: Observation[] = [];
    for (const e of entries) {
      if (e.type === 'node') {
        const node = e as PveNodeEntry;
        if (node.online !== 1) {
          out.push(
            this.makeObservation({
              platform: this.platformId,
              pattern: 'daemon_heartbeat_stale',
              resource: `node/${node.name}`,
              severity: 'P0',
              details: { online: node.online ?? 0 },
            }),
          );
        }
      } else if (e.type === 'storage') {
        const stor = e as PveStorageEntry;
        if (stor.status !== 'available') {
          out.push(
            this.makeObservation({
              platform: this.platformId,
              pattern: 'disk_io_error',
              resource: `storage/${stor.storage}`,
              severity: 'P0',
              details: { status: stor.status ?? 'unknown' },
            }),
          );
        }
      }
    }
    return out;
  }
}
