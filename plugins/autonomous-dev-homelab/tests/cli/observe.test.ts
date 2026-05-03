/**
 * SPEC-002-1-04 — `observe scan/list/promote` CLI tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { buildObserveCommand, parseSince } from '../../src/cli/commands/observe';
import { ObservationCollector } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import { ObservationStore } from '../../src/observation/persistence';
import { ObservationPromoter } from '../../src/observation/promoter';
import type { Observation, Probe } from '../../src/observation/types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface Captured {
  stdout: string;
  stderr: string;
}

function capture(): { captured: Captured; streams: { stdout: (s: string) => void; stderr: (s: string) => void } } {
  const captured: Captured = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s) => { captured.stdout += s; },
      stderr: (s) => { captured.stderr += s; },
    },
  };
}

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    platform: overrides.platform ?? 'k3s-01',
    pattern: overrides.pattern ?? 'oom_kill',
    resource: overrides.resource ?? 'Pod/web-7c',
    severity: overrides.severity ?? 'P1',
    discovered_at: overrides.discovered_at ?? '2026-05-01T12:00:00.000Z',
  };
}

function fakeProbe(emit: () => Observation[]): Probe & { scan: jest.Mock } {
  return {
    id: 'fake',
    platformId: 'k3s-01',
    cadence: 'fast',
    scan: jest.fn(async () => emit()),
  };
}

describe('parseSince', () => {
  const NOW = Date.parse('2026-05-02T00:00:00.000Z');
  test('30m → 30 minutes ago', () => {
    expect(parseSince('30m', NOW)?.toISOString()).toBe('2026-05-01T23:30:00.000Z');
  });
  test('1h', () => {
    expect(parseSince('1h', NOW)?.toISOString()).toBe('2026-05-01T23:00:00.000Z');
  });
  test('24h', () => {
    expect(parseSince('24h', NOW)?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
  test('7d', () => {
    expect(parseSince('7d', NOW)?.toISOString()).toBe('2026-04-25T00:00:00.000Z');
  });
  test('ISO timestamp parses', () => {
    expect(parseSince('2026-05-01T00:00:00Z', NOW)?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
  test('invalid input returns null', () => {
    expect(parseSince('not-a-date', NOW)).toBeNull();
  });
});

describe('observe scan', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkTempDir('observe-cli-'); });
  afterEach(async () => { await rmTempDir(dataDir); });

  test('runs probes and prints fresh-count summary', async () => {
    const probe = fakeProbe(() => [obs()]);
    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({ execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }) });
    const collector = new ObservationCollector({ probes: [probe], dedup, store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['scan'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('1 fresh observation');
    expect(probe.scan).toHaveBeenCalled();
  });

  test('--platform filters to that platform only', async () => {
    const a: Probe & { scan: jest.Mock } = {
      id: 'k8s',
      platformId: 'k3s-01',
      cadence: 'fast',
      scan: jest.fn(async () => [obs({ resource: 'Pod/a' })]),
    };
    const b: Probe & { scan: jest.Mock } = {
      id: 'docker',
      platformId: 'docker-01',
      cadence: 'fast',
      scan: jest.fn(async () => [obs({ resource: 'Pod/b' })]),
    };
    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({ execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }) });
    const collector = new ObservationCollector({ probes: [a, b], dedup, store, promoter });
    const { streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['scan', '--platform', 'k3s-01'], { from: 'user' });
    expect(a.scan).toHaveBeenCalled();
    expect(b.scan).not.toHaveBeenCalled();
  });

  test('--dry-run does NOT save or promote', async () => {
    const probe = fakeProbe(() => [obs()]);
    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const promoter = new ObservationPromoter({ execFile });
    const collector = new ObservationCollector({ probes: [probe], dedup, store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['scan', '--dry-run'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('dry-run');
    expect(execFile).not.toHaveBeenCalled();
    // No observation files written
    const filesAfter = await fs.readdir(path.join(dataDir, 'observations')).catch(() => []);
    expect(filesAfter.length).toBe(0);
  });

  test('--json outputs structured payload', async () => {
    const probe = fakeProbe(() => [obs()]);
    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter({ execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }) });
    const collector = new ObservationCollector({ probes: [probe], dedup, store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['scan', '--json'], { from: 'user' });
    const payload = JSON.parse(captured.stdout) as { count: number; observations: Observation[] };
    expect(payload.count).toBe(1);
    expect(payload.observations).toHaveLength(1);
  });
});

describe('observe list', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkTempDir('observe-list-'); });
  afterEach(async () => { await rmTempDir(dataDir); });

  test('--since 1h --severity P0 --json filters correctly', async () => {
    const NOW = Date.parse('2026-05-02T12:00:00.000Z');
    const store = new ObservationStore(dataDir);
    await store.save(
      obs({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        severity: 'P0',
        discovered_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
    );
    await store.save(
      obs({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        severity: 'P1',
        discovered_at: new Date(NOW - 30 * 60_000).toISOString(),
      }),
    );
    await store.save(
      obs({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        severity: 'P0',
        discovered_at: new Date(NOW - 2 * 3_600_000).toISOString(),
      }),
    );
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({
      probes: [],
      dedup: new DedupCache(),
      store,
      promoter,
    });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams, now: () => NOW });
    await handle.command.parseAsync(['list', '--since', '1h', '--severity', 'P0', '--json'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    const arr = JSON.parse(captured.stdout) as Observation[];
    expect(arr).toHaveLength(1);
    expect(arr[0]!.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  test('rejects unknown --severity', async () => {
    const store = new ObservationStore(dataDir);
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['list', '--severity', 'P9'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('invalid --severity');
  });

  test('rejects malformed --since', async () => {
    const store = new ObservationStore(dataDir);
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['list', '--since', 'nope'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('invalid --since');
  });

  test('table output prints columns when not --json', async () => {
    const store = new ObservationStore(dataDir);
    await store.save(obs());
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });
    expect(captured.stdout).toContain('severity');
    expect(captured.stdout).toContain('pattern');
    expect(captured.stdout).toContain('oom_kill');
  });

  test('reports "no observations match" when filter empty', async () => {
    const store = new ObservationStore(dataDir);
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });
    expect(captured.stdout).toContain('no observations match');
  });
});

describe('observe promote', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkTempDir('observe-promote-'); });
  afterEach(async () => { await rmTempDir(dataDir); });

  test('promotes a stored observation by id, bypassing dedup', async () => {
    const store = new ObservationStore(dataDir);
    const o = obs();
    await store.save(o);
    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const promoter = new ObservationPromoter({ execFile });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['promote', o.id], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(captured.stdout).toContain(`promoted ${o.id}`);
  });

  test('exits 1 with clear message if observation id is missing', async () => {
    const store = new ObservationStore(dataDir);
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['promote', 'no-such-id'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('observation not found');
  });

  test('--override-type infra forwards to promoter and warns on stderr', async () => {
    const store = new ObservationStore(dataDir);
    const o = obs({ pattern: 'oom_kill' });
    await store.save(o);
    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const promoter = new ObservationPromoter({ execFile });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['promote', o.id, '--override-type', 'infra'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stderr).toContain('--override-type bypasses');
    const args = execFile.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('--type') + 1]).toBe('infra');
  });

  test('rejects invalid --override-type', async () => {
    const store = new ObservationStore(dataDir);
    const o = obs();
    await store.save(o);
    const promoter = new ObservationPromoter({ execFile: jest.fn() });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['promote', o.id, '--override-type', 'sneaky'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('invalid --override-type');
  });

  test('promoter failure surfaces as exit 1', async () => {
    const store = new ObservationStore(dataDir);
    const o = obs();
    await store.save(o);
    const promoter = new ObservationPromoter({
      execFile: jest.fn().mockRejectedValue(new Error('autonomous-dev: not found')),
    });
    const collector = new ObservationCollector({ probes: [], dedup: new DedupCache(), store, promoter });
    const { captured, streams } = capture();
    const handle = buildObserveCommand({ collector, store, promoter, streams });
    await handle.command.parseAsync(['promote', o.id], { from: 'user' });
    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('promotion failed');
  });
});
