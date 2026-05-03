/**
 * Path resolution for homelab deploy backend state files. SPEC-002-3-01.
 *
 * Mirrors `src/safety/state-paths.ts`: data dir resolves from
 * `HOMELAB_DATA_DIR` → `CLAUDE_PLUGIN_DATA` → `<cwd>/.homelab-data`.
 *
 * The strict id regex blocks path-traversal via crafted vmids /
 * container names.
 */

import * as path from 'node:path';

export function deployDataDir(): string {
  const fromEnv = process.env['HOMELAB_DATA_DIR'] ?? process.env['CLAUDE_PLUGIN_DATA'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.resolve(process.cwd(), '.homelab-data');
}

export function proxmoxRecordsDir(): string {
  return path.join(deployDataDir(), 'proxmox');
}

export function unraidRecordsDir(): string {
  return path.join(deployDataDir(), 'unraid');
}

const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export function proxmoxRecordPath(vmid: number | string): string {
  const key = String(vmid);
  if (!SAFE_KEY.test(key)) {
    throw new Error(`invalid proxmox record key: ${key}`);
  }
  return path.join(proxmoxRecordsDir(), `${key}.json`);
}

export function unraidRecordPath(containerName: string): string {
  if (!SAFE_KEY.test(containerName)) {
    throw new Error(`invalid unraid record key: ${containerName}`);
  }
  return path.join(unraidRecordsDir(), `${containerName}.json`);
}
