/**
 * SPEC-002-1-03 — SMARTProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SMARTProbe, parseSmartctl } from '../../../src/observation/probes/smart';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'truenas-01';

function multiCommandSource(handlers: Record<string, string | Error>): {
  platformId: string;
  exec: jest.Mock;
} {
  const exec = jest.fn(async (cmd: string) => {
    const handler = handlers[cmd];
    if (handler === undefined) throw new Error(`unhandled cmd: ${cmd}`);
    if (handler instanceof Error) throw handler;
    return { stdout: handler };
  });
  return { platformId: PLATFORM, exec };
}

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIX_DIR, name), 'utf8');
}

describe('SMARTProbe', () => {
  test('exposes id, cadence, platformId', () => {
    const probe = new SMARTProbe(multiCommandSource({}));
    expect(probe.id).toBe('smart');
    expect(probe.cadence).toBe('daily');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('healthy device → []', async () => {
    const healthy = await loadFixture('smartctl-healthy.txt');
    const probe = new SMARTProbe(
      multiCommandSource({
        'lsblk -dn -o NAME': 'sda\n',
        'smartctl --all /dev/sda': healthy,
      }),
    );
    expect(await probe.scan()).toEqual([]);
  });

  test('reallocated sectors → 1 disk_io_error observation', async () => {
    const reallocated = await loadFixture('smartctl-reallocated-sectors.txt');
    const probe = new SMARTProbe(
      multiCommandSource({
        'lsblk -dn -o NAME': 'sda\n',
        'smartctl --all /dev/sda': reallocated,
      }),
    );
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('disk_io_error');
    expect(out[0]!.resource).toBe(`disk/${PLATFORM}:sda`);
    expect(out[0]!.severity).toBe('P0');
    expect((out[0]!.details as { reallocated: number }).reallocated).toBe(42);
    expect((out[0]!.details as { pending: number }).pending).toBe(0);
  });

  test('pending sectors → 1 observation', async () => {
    const pending = await loadFixture('smartctl-pending-sectors.txt');
    const probe = new SMARTProbe(
      multiCommandSource({
        'lsblk -dn -o NAME': 'sdb\n',
        'smartctl --all /dev/sdb': pending,
      }),
    );
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect((out[0]!.details as { pending: number }).pending).toBe(7);
  });

  test('per-device error skips device but does NOT fail the scan', async () => {
    const healthy = await loadFixture('smartctl-healthy.txt');
    const probe = new SMARTProbe(
      multiCommandSource({
        'lsblk -dn -o NAME': 'sda\nsdb\n',
        'smartctl --all /dev/sda': new Error('not a smart-capable device'),
        'smartctl --all /dev/sdb': healthy,
      }),
    );
    expect(await probe.scan()).toEqual([]);
  });

  test('lsblk failure → single unreachable sentinel', async () => {
    const probe = new SMARTProbe({
      platformId: PLATFORM,
      exec: jest.fn().mockRejectedValue(new Error('lsblk: not found')),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.details).toMatchObject({ probe: 'smart' });
  });

  describe('parseSmartctl', () => {
    test('extracts reallocated and pending sector counts', async () => {
      const stdout = await loadFixture('smartctl-reallocated-sectors.txt');
      const finding = parseSmartctl('sda', stdout);
      expect(finding.reallocated).toBe(42);
      expect(finding.pending).toBe(0);
      expect(finding.overall_health).toBe('PASSED');
    });

    test('returns UNKNOWN health when line absent', () => {
      const finding = parseSmartctl('sda', '');
      expect(finding.overall_health).toBe('UNKNOWN');
      expect(finding.reallocated).toBe(0);
      expect(finding.pending).toBe(0);
    });
  });
});
