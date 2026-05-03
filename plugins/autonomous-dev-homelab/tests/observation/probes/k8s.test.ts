/**
 * SPEC-002-1-02 — K8sProbe unit tests.
 *
 * Mocks `K8sConnection.exec` so the test suite never spawns kubectl.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { K8sProbe } from '../../../src/observation/probes/k8s';
import type { K8sConnection } from '../../../src/connection/k8s';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'k3s-01';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface MockConn {
  platformId: string;
  exec: jest.Mock;
}

function mockConn(stdout: string): MockConn {
  return {
    platformId: PLATFORM,
    exec: jest.fn().mockResolvedValue({ stdout }),
  };
}

function failingConn(err: Error): MockConn {
  return {
    platformId: PLATFORM,
    exec: jest.fn().mockRejectedValue(err),
  };
}

describe('K8sProbe', () => {
  test('exposes id="k8s", cadence="fast", platformId from connection', () => {
    const probe = new K8sProbe(mockConn('{}') as unknown as K8sConnection);
    expect(probe.id).toBe('k8s');
    expect(probe.cadence).toBe('fast');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('emits 3 observations from 2-backoff + 1-oom fixture', async () => {
    const stdout = await fs.readFile(
      path.join(FIX_DIR, 'k8s-events-2backoff-1oom.json'),
      'utf8',
    );
    const probe = new K8sProbe(mockConn(stdout) as unknown as K8sConnection);
    const out = await probe.scan();

    expect(out).toHaveLength(3);
    const patterns = out.map((o) => o.pattern).sort();
    expect(patterns).toEqual(['crash_loop', 'crash_loop', 'oom_kill']);

    const oom = out.find((o) => o.pattern === 'oom_kill');
    expect(oom).toBeDefined();
    expect(oom!.resource).toBe('Pod/worker-9z');
    expect(oom!.severity).toBe('P1');
    expect(oom!.platform).toBe(PLATFORM);
    expect(oom!.id).toMatch(UUID_RE);
    expect(oom!.discovered_at).toMatch(ISO_RE);
    expect(oom!.dedup_key).toBe(`${PLATFORM}:oom_kill:Pod/worker-9z`);
    expect(oom!.details).toEqual({
      count: 1,
      message: 'Container exceeded memory limit',
    });

    const backoffs = out.filter((o) => o.pattern === 'crash_loop');
    expect(backoffs.map((o) => o.resource).sort()).toEqual([
      'Pod/api-2d',
      'Pod/web-7c',
    ]);
    for (const b of backoffs) {
      expect(b.severity).toBe('P1');
      expect(b.dedup_key).toBe(`${PLATFORM}:crash_loop:${b.resource}`);
    }
  });

  test('returns [] for empty events fixture', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'k8s-events-empty.json'), 'utf8');
    const probe = new K8sProbe(mockConn(stdout) as unknown as K8sConnection);
    expect(await probe.scan()).toEqual([]);
  });

  test('returns [] when only non-target reasons are present', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'k8s-events-noise.json'), 'utf8');
    const probe = new K8sProbe(mockConn(stdout) as unknown as K8sConnection);
    expect(await probe.scan()).toEqual([]);
  });

  test('connection error → single daemon_heartbeat_stale, no throw', async () => {
    const probe = new K8sProbe(
      failingConn(new Error('dial tcp: connection refused')) as unknown as K8sConnection,
    );
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.severity).toBe('P0');
    expect(out[0]!.resource).toBe(`cluster/${PLATFORM}`);
    expect(out[0]!.details).toMatchObject({
      probe: 'k8s',
      reason: 'platform_unreachable',
    });
    expect(typeof out[0]!.details!['error']).toBe('string');
  });

  test('malformed JSON stdout falls back to unreachable sentinel', async () => {
    const probe = new K8sProbe(mockConn('not-json') as unknown as K8sConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
  });

  test('handles fixture with missing items array gracefully', async () => {
    const probe = new K8sProbe(mockConn('{}') as unknown as K8sConnection);
    expect(await probe.scan()).toEqual([]);
  });
});
