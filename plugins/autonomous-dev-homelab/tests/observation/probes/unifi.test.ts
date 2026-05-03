/**
 * SPEC-002-1-03 — UnifiProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { UnifiProbe, type UnifiEvent, type UnifiEventSource } from '../../../src/observation/probes/unifi';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'unifi-controller-01';

function source(events: UnifiEvent[]): UnifiEventSource {
  return {
    platformId: PLATFORM,
    getEvents: jest.fn().mockResolvedValue(events),
  };
}

async function load(name: string): Promise<UnifiEvent[]> {
  return JSON.parse(await fs.readFile(path.join(FIX_DIR, name), 'utf8')) as UnifiEvent[];
}

describe('UnifiProbe', () => {
  test('exposes id, cadence, platformId', () => {
    const probe = new UnifiProbe(source([]));
    expect(probe.id).toBe('unifi');
    expect(probe.cadence).toBe('medium');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('clean events → []', async () => {
    const probe = new UnifiProbe(source(await load('unifi-events-clean.json')));
    expect(await probe.scan()).toEqual([]);
  });

  test('one-ap-offline → 1 unifi_ap_offline observation', async () => {
    const probe = new UnifiProbe(source(await load('unifi-events-one-ap-offline.json')));
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('unifi_ap_offline');
    expect(out[0]!.resource).toBe('ap/aa:bb:cc:00:00:02');
    expect(out[0]!.severity).toBe('P1');
    expect(out[0]!.details).toEqual({ msg: 'AP lost contact', time: 1714449500 });
  });

  test('multi-ap-offline → 3 observations', async () => {
    const probe = new UnifiProbe(source(await load('unifi-events-multi-ap-offline.json')));
    const out = await probe.scan();
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.resource).sort()).toEqual([
      'ap/aa:bb:cc:00:00:01',
      'ap/aa:bb:cc:00:00:02',
      'ap/aa:bb:cc:00:00:03',
    ]);
  });

  test('connection error → unreachable sentinel', async () => {
    const probe = new UnifiProbe({
      platformId: PLATFORM,
      getEvents: jest.fn().mockRejectedValue(new Error('401 unauthorized')),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.details).toMatchObject({ probe: 'unifi' });
  });
});
