/**
 * SPEC-002-1-03 — ProxmoxProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ProxmoxProbe } from '../../../src/observation/probes/proxmox';
import type { ProxmoxConnection } from '../../../src/connection/proxmox';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'pve-cluster-01';

function mockConn(stdout: string): { platformId: string; exec: jest.Mock } {
  return { platformId: PLATFORM, exec: jest.fn().mockResolvedValue({ stdout }) };
}

describe('ProxmoxProbe', () => {
  test('exposes id, cadence, platformId', () => {
    const probe = new ProxmoxProbe(mockConn('[]') as unknown as ProxmoxConnection);
    expect(probe.id).toBe('proxmox');
    expect(probe.cadence).toBe('medium');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('healthy fixture → []', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'proxmox-healthy.json'), 'utf8');
    const probe = new ProxmoxProbe(mockConn(stdout) as unknown as ProxmoxConnection);
    expect(await probe.scan()).toEqual([]);
  });

  test('one-down fixture → 1 daemon_heartbeat_stale on the offline node', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'proxmox-one-down.json'), 'utf8');
    const probe = new ProxmoxProbe(mockConn(stdout) as unknown as ProxmoxConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.resource).toBe('node/pve-02');
    expect(out[0]!.severity).toBe('P0');
    expect(out[0]!.details).toEqual({ online: 0 });
  });

  test('storage-degraded fixture → 1 disk_io_error on unavailable storage', async () => {
    const stdout = await fs.readFile(
      path.join(FIX_DIR, 'proxmox-storage-degraded.json'),
      'utf8',
    );
    const probe = new ProxmoxProbe(mockConn(stdout) as unknown as ProxmoxConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('disk_io_error');
    expect(out[0]!.resource).toBe('storage/nfs-data');
    expect(out[0]!.severity).toBe('P0');
    expect(out[0]!.details).toEqual({ status: 'unavailable' });
  });

  test('connection error → unreachable sentinel, no throw', async () => {
    const conn = { platformId: PLATFORM, exec: jest.fn().mockRejectedValue(new Error('ECONN')) };
    const probe = new ProxmoxProbe(conn as unknown as ProxmoxConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.details).toMatchObject({ probe: 'proxmox', reason: 'platform_unreachable' });
  });

  test('malformed JSON → unreachable sentinel', async () => {
    const probe = new ProxmoxProbe(mockConn('garbage') as unknown as ProxmoxConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
  });
});
