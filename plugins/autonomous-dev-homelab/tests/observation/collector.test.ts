/**
 * SPEC-002-1-04 — ObservationCollector tests.
 *
 * Uses fake `setInterval` / `clearInterval` injected via the test seam
 * so we can verify timer wiring without depending on jest fake timers.
 */

import { ObservationCollector, CADENCE_MS } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import type { ObservationStore } from '../../src/observation/persistence';
import type { ObservationPromoter } from '../../src/observation/promoter';
import type { Observation, Probe } from '../../src/observation/types';

const ISO = '2026-05-01T00:00:00.000Z';

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    platform: overrides.platform ?? 'k3s-01',
    pattern: overrides.pattern ?? 'oom_kill',
    resource: overrides.resource ?? 'Pod/web-7c',
    severity: overrides.severity ?? 'P1',
    discovered_at: overrides.discovered_at ?? ISO,
    dedup_key:
      overrides.dedup_key ??
      `${overrides.platform ?? 'k3s-01'}:${overrides.pattern ?? 'oom_kill'}:${overrides.resource ?? 'Pod/web-7c'}`,
  };
}

function fakeProbe(opts: {
  id: string;
  platformId: string;
  cadence?: Probe['cadence'];
  emit?: () => Observation[];
}): Probe & { scan: jest.Mock } {
  return {
    id: opts.id,
    platformId: opts.platformId,
    cadence: opts.cadence ?? 'fast',
    scan: jest.fn(async () => (opts.emit ? opts.emit() : [])),
  };
}

function mockStore(): jest.Mocked<ObservationStore> {
  return {
    save: jest.fn().mockResolvedValue('/tmp/x.json'),
    load: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    cleanup: jest.fn().mockResolvedValue(0),
    getDir: jest.fn().mockReturnValue('/tmp/observations'),
  } as unknown as jest.Mocked<ObservationStore>;
}

function mockPromoter(): jest.Mocked<ObservationPromoter> {
  return {
    promote: jest.fn().mockResolvedValue(undefined),
    mapToRequestType: jest.fn(),
    mapToDestructiveness: jest.fn(),
    buildBugReport: jest.fn(),
  } as unknown as jest.Mocked<ObservationPromoter>;
}

describe('ObservationCollector — runProbe flow', () => {
  test('emits → save + promote on first run; dedup suppresses second run', async () => {
    const o = obs();
    const probe = fakeProbe({ id: 'k8s', platformId: 'k3s-01', emit: () => [o] });
    const store = mockStore();
    const promoter = mockPromoter();
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(),
      store,
      promoter,
    });
    const first = await collector.runProbe(probe);
    expect(first).toEqual([o]);
    expect(store.save).toHaveBeenCalledWith(o);
    expect(promoter.promote).toHaveBeenCalledWith(o);

    const second = await collector.runProbe(probe);
    expect(second).toEqual([]);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(promoter.promote).toHaveBeenCalledTimes(1);
  });

  test('dryRun skips save + promote but returns observations', async () => {
    const o = obs();
    const probe = fakeProbe({ id: 'k8s', platformId: 'k3s-01', emit: () => [o] });
    const store = mockStore();
    const promoter = mockPromoter();
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(),
      store,
      promoter,
    });
    const out = await collector.runProbe(probe, { dryRun: true });
    expect(out).toEqual([o]);
    expect(store.save).not.toHaveBeenCalled();
    expect(promoter.promote).not.toHaveBeenCalled();
  });

  test('an unexpected throw inside scan does NOT crash the loop', async () => {
    const probe: Probe = {
      id: 'broken',
      platformId: 'p',
      cadence: 'fast',
      scan: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const warn = jest.fn();
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(),
      store: mockStore(),
      promoter: mockPromoter(),
      logger: { warn },
    });
    const out = await collector.runProbe(probe);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test('save error during runProbe → skip promote, continue with rest', async () => {
    const a = obs({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resource: 'Pod/a' });
    const b = obs({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resource: 'Pod/b' });
    const probe = fakeProbe({ id: 'k8s', platformId: 'p', emit: () => [a, b] });
    const store = mockStore();
    store.save
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce('/tmp/b.json');
    const promoter = mockPromoter();
    const warn = jest.fn();
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(),
      store,
      promoter,
      logger: { warn },
    });
    const out = await collector.runProbe(probe);
    expect(out).toEqual([b]);
    expect(promoter.promote).toHaveBeenCalledTimes(1);
    expect(promoter.promote).toHaveBeenCalledWith(b);
    expect(warn).toHaveBeenCalled();
  });

  test('promoter rejection is logged but does not crash the loop', async () => {
    const o = obs();
    const probe = fakeProbe({ id: 'k8s', platformId: 'p', emit: () => [o] });
    const promoter = mockPromoter();
    promoter.promote.mockRejectedValueOnce(new Error('autonomous-dev not on PATH'));
    const warn = jest.fn();
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(),
      store: mockStore(),
      promoter,
      logger: { warn },
    });
    const out = await collector.runProbe(probe);
    expect(out).toEqual([o]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('ObservationCollector — runAll', () => {
  test('filters probes by platformId', async () => {
    const a = fakeProbe({ id: 'k8s', platformId: 'k3s-01' });
    const b = fakeProbe({ id: 'docker', platformId: 'docker-01' });
    const collector = new ObservationCollector({
      probes: [a, b],
      dedup: new DedupCache(),
      store: mockStore(),
      promoter: mockPromoter(),
    });
    await collector.runAll({ platformId: 'k3s-01' });
    expect(a.scan).toHaveBeenCalled();
    expect(b.scan).not.toHaveBeenCalled();
  });

  test('runs every probe when filter omitted', async () => {
    const a = fakeProbe({ id: 'k8s', platformId: 'k3s-01' });
    const b = fakeProbe({ id: 'docker', platformId: 'docker-01' });
    const collector = new ObservationCollector({
      probes: [a, b],
      dedup: new DedupCache(),
      store: mockStore(),
      promoter: mockPromoter(),
    });
    await collector.runAll();
    expect(a.scan).toHaveBeenCalled();
    expect(b.scan).toHaveBeenCalled();
  });
});

describe('ObservationCollector — start/stop scheduling', () => {
  test('start schedules one timer per probe + one cleanup timer; stop clears all', async () => {
    interface FakeTimer {
      ms: number;
      cb: () => void;
    }
    const timers: FakeTimer[] = [];
    const setIntervalFake = (cb: () => void, ms: number): NodeJS.Timeout => {
      const t = { ms, cb } as FakeTimer;
      timers.push(t);
      return t as unknown as NodeJS.Timeout;
    };
    const clearIntervalFake = (t: NodeJS.Timeout): void => {
      const idx = timers.findIndex((x) => x === (t as unknown as FakeTimer));
      if (idx >= 0) timers.splice(idx, 1);
    };
    const probes = [
      fakeProbe({ id: 'k8s', platformId: 'k3s-01', cadence: 'fast' }),
      fakeProbe({ id: 'proxmox', platformId: 'pve-01', cadence: 'medium' }),
      fakeProbe({ id: 'cert-expiry', platformId: 'edge', cadence: 'slow' }),
      fakeProbe({ id: 'zfs', platformId: 'truenas', cadence: 'daily' }),
    ];
    const collector = new ObservationCollector({
      probes,
      dedup: new DedupCache(),
      store: mockStore(),
      promoter: mockPromoter(),
      setInterval: setIntervalFake,
      clearInterval: clearIntervalFake,
    });
    await collector.start();
    expect(timers).toHaveLength(probes.length + 1); // +cleanup timer
    expect(timers[0]!.ms).toBe(CADENCE_MS.fast);
    expect(timers[1]!.ms).toBe(CADENCE_MS.medium);
    expect(timers[2]!.ms).toBe(CADENCE_MS.slow);
    expect(timers[3]!.ms).toBe(CADENCE_MS.daily);
    expect(timers[4]!.ms).toBe(24 * 3_600_000);

    // Manually fire a fast-cadence callback → probe.scan invoked
    timers[0]!.cb();
    await new Promise((r) => setImmediate(r));
    expect(probes[0]!.scan).toHaveBeenCalled();

    await collector.stop();
    expect(timers).toHaveLength(0);
  });

  test('start hydrates dedup from recent persisted observations', async () => {
    const fakeNow = 1_700_000_000_000;
    const recent = obs({
      dedup_key: 'k3s-01:oom_kill:Pod/web-7c',
      discovered_at: new Date(fakeNow - 30 * 60_000).toISOString(),
    });
    const store = mockStore();
    store.list.mockResolvedValueOnce([recent]);
    const dedup = new DedupCache();
    const setIntervalFake = (_cb: () => void, _ms: number): NodeJS.Timeout =>
      ({}) as unknown as NodeJS.Timeout;
    const collector = new ObservationCollector({
      probes: [],
      dedup,
      store,
      promoter: mockPromoter(),
      setInterval: setIntervalFake,
      clearInterval: () => undefined,
    });
    await collector.start(fakeNow);
    expect(
      dedup.isDuplicate(obs({ dedup_key: 'k3s-01:oom_kill:Pod/web-7c' }), fakeNow),
    ).toBe(true);
  });
});
