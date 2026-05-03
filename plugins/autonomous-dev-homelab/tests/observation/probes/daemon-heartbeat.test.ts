/**
 * SPEC-002-1-03 — DaemonHeartbeatProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DaemonHeartbeatProbe } from '../../../src/observation/probes/daemon-heartbeat';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

const PLATFORM = 'autonomous-dev-daemon';
const NOW_ISO = '2026-05-02T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

describe('DaemonHeartbeatProbe', () => {
  let dataDir: string;
  let heartbeatPath: string;
  beforeEach(async () => {
    dataDir = await mkTempDir();
    heartbeatPath = path.join(dataDir, 'daemon-heartbeat.json');
  });
  afterEach(async () => {
    await rmTempDir(dataDir);
  });

  test('exposes id, cadence, platformId', () => {
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    expect(probe.id).toBe('daemon-heartbeat');
    expect(probe.cadence).toBe('fast');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('fresh heartbeat (30s ago) → []', async () => {
    await fs.writeFile(
      heartbeatPath,
      JSON.stringify({ last_beat: new Date(NOW_MS - 30_000).toISOString(), pid: 1234 }),
      'utf8',
    );
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('stale heartbeat (10min ago) → 1 daemon_heartbeat_stale observation', async () => {
    await fs.writeFile(
      heartbeatPath,
      JSON.stringify({ last_beat: new Date(NOW_MS - 600_000).toISOString(), pid: 1234 }),
      'utf8',
    );
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.severity).toBe('P0');
    expect(out[0]!.resource).toBe('daemon/autonomous-dev');
    expect((out[0]!.details as { age_seconds: number }).age_seconds).toBeGreaterThanOrEqual(600);
  });

  test('missing heartbeat file → 1 observation, age_seconds Infinity', async () => {
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect((out[0]!.details as { age_seconds: number }).age_seconds).toBe(Number.POSITIVE_INFINITY);
    expect((out[0]!.details as { reason: string }).reason).toBe('heartbeat_missing');
  });

  test('malformed heartbeat JSON → 1 observation with parser error', async () => {
    await fs.writeFile(heartbeatPath, 'not-json', 'utf8');
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect((out[0]!.details as { reason: string }).reason).toBe('heartbeat_unparseable');
  });

  test('heartbeat with invalid timestamp → 1 observation with timestamp reason', async () => {
    await fs.writeFile(heartbeatPath, JSON.stringify({ last_beat: 'nope', pid: 1 }), 'utf8');
    const probe = new DaemonHeartbeatProbe({
      platformId: PLATFORM,
      heartbeatPath,
      now: () => NOW_MS,
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect((out[0]!.details as { reason: string }).reason).toBe('heartbeat_invalid_timestamp');
  });
});
