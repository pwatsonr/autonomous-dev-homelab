/**
 * Proxmox CLI helpers wrapping `pct` (LXC) + `qm` (VM) over a homelab
 * `Connection`. SPEC-002-3-01 §"`proxmox-cli.ts`".
 *
 * Centralises argument quoting + stderr trimming so neither
 * `ProxmoxHomelabBackend.build` nor `.deploy` shells out via
 * `child_process` directly. All commands flow through `Connection.exec`
 * (which is `execFile`-backed at the SSH layer).
 */

import type { Connection, ExecResult } from '../../connection/base.js';
import { DeployError } from '../errors.js';

export type WorkloadKind = 'lxc' | 'vm';

export interface PctCreateOpts {
  vmid: number;
  imageUri: string;
  storagePool: string;
  hostname: string;
  cores: number;
  memoryMb: number;
  ipCidr?: string;
}

export interface QmCreateOpts {
  vmid: number;
  hostname: string;
  cores: number;
  memoryMb: number;
  imageUri: string;
  storagePool: string;
}

export type ContainerStatus = 'running' | 'stopped' | 'unknown';

const SHELL_SAFE = /^[A-Za-z0-9_./@:+=,-]+$/;
const CIDR_REGEX = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

function ensureSafe(name: string, value: string): string {
  if (!SHELL_SAFE.test(value)) {
    throw new DeployError({
      code: 'INVALID_PARAMS',
      message: `proxmox-cli: arg '${name}' contains shell-unsafe characters`,
    });
  }
  return value;
}

function buildPctCreateCmd(opts: PctCreateOpts): string {
  const parts: string[] = [
    'pct',
    'create',
    String(opts.vmid),
    ensureSafe('image_uri', opts.imageUri),
    '--storage',
    ensureSafe('storage_pool', opts.storagePool),
    '--hostname',
    ensureSafe('hostname', opts.hostname),
    '--cores',
    String(opts.cores),
    '--memory',
    String(opts.memoryMb),
  ];
  if (opts.ipCidr !== undefined) {
    if (!CIDR_REGEX.test(opts.ipCidr)) {
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `proxmox-cli: ip_cidr '${opts.ipCidr}' is not a CIDR`,
      });
    }
    parts.push('--net0', `name=eth0,ip=${opts.ipCidr}`);
  }
  return parts.join(' ');
}

function buildQmCreateCmd(opts: QmCreateOpts): string {
  return [
    'qm',
    'create',
    String(opts.vmid),
    '--name',
    ensureSafe('hostname', opts.hostname),
    '--cores',
    String(opts.cores),
    '--memory',
    String(opts.memoryMb),
    '--net0',
    'virtio,bridge=vmbr0',
    '--ide2',
    `${ensureSafe('storage_pool', opts.storagePool)}:cloudinit`,
    '--boot',
    'order=scsi0',
  ].join(' ');
}

function buildQmImportDiskCmd(vmid: number, imageUri: string, storagePool: string): string {
  return [
    'qm',
    'importdisk',
    String(vmid),
    ensureSafe('image_uri', imageUri),
    ensureSafe('storage_pool', storagePool),
  ].join(' ');
}

function trimStderr(s: string): string {
  return s.length > 500 ? s.slice(0, 500) : s;
}

export async function runPctCreate(
  conn: Connection,
  opts: PctCreateOpts,
): Promise<ExecResult> {
  const cmd = buildPctCreateCmd(opts);
  const result = await conn.exec(cmd);
  if (result.exitCode !== 0) {
    throw new DeployError({
      code: 'BUILD_FAILED',
      message: trimStderr(result.stderr || result.stdout),
    });
  }
  return result;
}

export async function runQmCreate(
  conn: Connection,
  opts: QmCreateOpts,
): Promise<ExecResult> {
  const create = await conn.exec(buildQmCreateCmd(opts));
  if (create.exitCode !== 0) {
    throw new DeployError({
      code: 'BUILD_FAILED',
      message: trimStderr(create.stderr || create.stdout),
    });
  }
  const importResult = await conn.exec(
    buildQmImportDiskCmd(opts.vmid, opts.imageUri, opts.storagePool),
  );
  if (importResult.exitCode !== 0) {
    throw new DeployError({
      code: 'BUILD_FAILED',
      message: trimStderr(importResult.stderr || importResult.stdout),
    });
  }
  return importResult;
}

export async function getContainerStatus(
  conn: Connection,
  kind: WorkloadKind,
  vmid: number,
): Promise<ContainerStatus> {
  const cmd = kind === 'lxc' ? `pct status ${vmid}` : `qm status ${vmid}`;
  const result = await conn.exec(cmd);
  if (result.exitCode !== 0) return 'unknown';
  const out = result.stdout.toLowerCase();
  if (out.includes('running')) return 'running';
  if (out.includes('stopped')) return 'stopped';
  return 'unknown';
}

export interface ParsedAddr {
  ip: string;
  cidr: number;
  iface: string;
}

/**
 * Parse the JSON output of `ip -j addr show eth0` to extract the first
 * non-loopback IPv4 address. Returns null when no usable address is found.
 */
export function parseIpJson(stdout: string): ParsedAddr | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    const e = entry as { ifname?: string; addr_info?: Array<{ family?: string; local?: string; prefixlen?: number }> };
    if (!Array.isArray(e.addr_info)) continue;
    for (const info of e.addr_info) {
      if (info.family === 'inet' && typeof info.local === 'string' && info.local !== '127.0.0.1') {
        return {
          ip: info.local,
          cidr: typeof info.prefixlen === 'number' ? info.prefixlen : 24,
          iface: e.ifname ?? 'eth0',
        };
      }
    }
  }
  return null;
}

export function parseVmid(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  throw new DeployError({
    code: 'INVALID_PARAMS',
    message: `vmid must be an integer; got ${String(raw)}`,
  });
}
