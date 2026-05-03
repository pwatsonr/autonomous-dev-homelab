/**
 * SPEC-002-1-03 — ZFSProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ZFSProbe, parseZpoolStatus } from '../../../src/observation/probes/zfs';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'truenas-01';

function src(stdout: string): { platformId: string; exec: jest.Mock } {
  return { platformId: PLATFORM, exec: jest.fn().mockResolvedValue({ stdout }) };
}

describe('ZFSProbe', () => {
  test('exposes id, cadence, platformId', () => {
    const probe = new ZFSProbe(src(''));
    expect(probe.id).toBe('zfs');
    expect(probe.cadence).toBe('daily');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('all-online fixture → []', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'zpool-online.txt'), 'utf8');
    const probe = new ZFSProbe(src(stdout));
    expect(await probe.scan()).toEqual([]);
  });

  test('degraded fixture → 1 zfs_pool_degraded observation', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'zpool-degraded.txt'), 'utf8');
    const probe = new ZFSProbe(src(stdout));
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('zfs_pool_degraded');
    expect(out[0]!.resource).toBe('pool/tank');
    expect(out[0]!.severity).toBe('P0');
    expect((out[0]!.details as { state: string }).state).toBe('DEGRADED');
    expect(typeof (out[0]!.details as { raw: string }).raw).toBe('string');
  });

  test('multi-pool faulted fixture → 2 observations (DEGRADED + FAULTED)', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'zpool-faulted.txt'), 'utf8');
    const probe = new ZFSProbe(src(stdout));
    const out = await probe.scan();
    expect(out).toHaveLength(2);
    const states = out.map((o) => (o.details as { state: string }).state).sort();
    expect(states).toEqual(['DEGRADED', 'FAULTED']);
    const resources = out.map((o) => o.resource).sort();
    expect(resources).toEqual(['pool/backup', 'pool/tank']);
  });

  test('connection error → unreachable sentinel', async () => {
    const probe = new ZFSProbe({
      platformId: PLATFORM,
      exec: jest.fn().mockRejectedValue(new Error('ssh: handshake failed')),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.details).toMatchObject({ probe: 'zfs' });
  });

  describe('parseZpoolStatus', () => {
    test('returns [] for empty input', () => {
      expect(parseZpoolStatus('')).toEqual([]);
      expect(parseZpoolStatus('   \n  \n')).toEqual([]);
    });

    test('returns [] when no pool: header is found', () => {
      expect(parseZpoolStatus('no pools available\n')).toEqual([]);
    });
  });
});
