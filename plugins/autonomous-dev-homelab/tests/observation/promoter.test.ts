/**
 * SPEC-002-1-04 — ObservationPromoter tests.
 */

import { ObservationPromoter } from '../../src/observation/promoter';
import type { Observation } from '../../src/observation/types';

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    platform: overrides.platform ?? 'k3s-01',
    pattern: overrides.pattern ?? 'oom_kill',
    resource: overrides.resource ?? 'Pod/web-7c',
    severity: overrides.severity ?? 'P1',
    discovered_at: overrides.discovered_at ?? '2026-05-01T00:00:00.000Z',
    ...(overrides.details !== undefined ? { details: overrides.details } : {}),
  };
}

describe('ObservationPromoter — catalog mapping', () => {
  const p = new ObservationPromoter({ execFile: jest.fn() });

  test('oom_kill → bug + persistent-modifying', () => {
    const o = obs({ pattern: 'oom_kill' });
    expect(p.mapToRequestType(o)).toBe('bug');
    expect(p.mapToDestructiveness(o)).toBe('persistent-modifying');
  });

  test('zfs_pool_degraded → infra + data-affecting', () => {
    const o = obs({ pattern: 'zfs_pool_degraded' });
    expect(p.mapToRequestType(o)).toBe('infra');
    expect(p.mapToDestructiveness(o)).toBe('data-affecting');
  });

  test('cert_expiry_imminent → hotfix + reversible', () => {
    const o = obs({ pattern: 'cert_expiry_imminent' });
    expect(p.mapToRequestType(o)).toBe('hotfix');
    expect(p.mapToDestructiveness(o)).toBe('reversible');
  });

  test('crash_loop → bug + reversible', () => {
    const o = obs({ pattern: 'crash_loop' });
    expect(p.mapToRequestType(o)).toBe('bug');
    expect(p.mapToDestructiveness(o)).toBe('reversible');
  });

  test('buildBugReport renders the expected fields', () => {
    const o = obs({ details: { count: 3 } });
    const report = p.buildBugReport(o);
    expect(report).toContain('Pattern: oom_kill on Pod/web-7c');
    expect(report).toContain('Platform: k3s-01');
    expect(report).toContain('Severity: P1');
    expect(report).toContain('Discovered: 2026-05-01T00:00:00.000Z');
    expect(report).toContain('Details: {"count":3}');
  });

  test('buildBugReport omits Details line when no details present', () => {
    const o = obs();
    expect(p.buildBugReport(o)).not.toContain('Details:');
  });
});

describe('ObservationPromoter — promote()', () => {
  test('invokes the autonomous-dev binary with full request-submit args', async () => {
    const execFile = jest
      .fn()
      .mockResolvedValue({ stdout: '', stderr: '' });
    const p = new ObservationPromoter({
      autonomousDevBin: 'fake-ad',
      defaultRepo: 'homelab',
      execFile,
    });
    const o = obs({ pattern: 'oom_kill' });
    await p.promote(o);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = execFile.mock.calls[0]!;
    expect(bin).toBe('fake-ad');
    expect(args).toEqual([
      'request',
      'submit',
      '--type',
      'bug',
      '--source',
      'production-intelligence',
      '--repo',
      'homelab',
      '--description',
      expect.stringContaining('oom_kill'),
      '--metadata',
      expect.stringContaining('"observation_id":"11111111-1111-4111-8111-111111111111"'),
    ]);
    const metadata = JSON.parse(args[args.length - 1] as string) as Record<string, unknown>;
    expect(metadata).toEqual({
      destructiveness: 'persistent-modifying',
      observation_id: '11111111-1111-4111-8111-111111111111',
      severity: 'P1',
    });
  });

  test('overrideType replaces request_type only for that submission', async () => {
    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const p = new ObservationPromoter({ execFile });
    await p.promote(obs({ pattern: 'oom_kill' }), { overrideType: 'infra' });
    const args = execFile.mock.calls[0]![1] as string[];
    const typeIdx = args.indexOf('--type');
    expect(args[typeIdx + 1]).toBe('infra');
  });

  test('execFile rejection propagates so collector can log', async () => {
    const execFile = jest.fn().mockRejectedValue(new Error('ENOENT: autonomous-dev'));
    const p = new ObservationPromoter({ execFile });
    await expect(p.promote(obs())).rejects.toThrow('ENOENT');
  });
});
