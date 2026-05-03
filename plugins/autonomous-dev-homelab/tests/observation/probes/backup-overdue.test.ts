/**
 * SPEC-002-1-03 — BackupOverdueProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BackupOverdueProbe } from '../../../src/observation/probes/backup-overdue';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

const PLATFORM = 'homelab';
const NOW_ISO = '2026-05-02T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

async function writeManifest(dataDir: string, body: unknown): Promise<void> {
  await fs.writeFile(
    path.join(dataDir, 'backup-manifest.json'),
    JSON.stringify(body),
    'utf8',
  );
}

describe('BackupOverdueProbe', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkTempDir();
  });
  afterEach(async () => {
    await rmTempDir(dataDir);
  });

  test('exposes id, cadence, platformId', () => {
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    expect(probe.id).toBe('backup-overdue');
    expect(probe.cadence).toBe('slow');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('fresh backup → []', async () => {
    await writeManifest(dataDir, {
      backups: [
        { id: 'restic-pg', last_run: new Date(NOW_MS - 60_000).toISOString(), max_age_hours: 24 },
      ],
    });
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    expect(await probe.scan()).toEqual([]);
  });

  test('one stale backup → 1 backup_overdue observation', async () => {
    const lastRun = new Date(NOW_MS - 36 * 3_600_000).toISOString(); // 36h ago, max=24h
    await writeManifest(dataDir, {
      backups: [{ id: 'restic-pg', last_run: lastRun, max_age_hours: 24 }],
    });
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('backup_overdue');
    expect(out[0]!.resource).toBe('backup/restic-pg');
    expect(out[0]!.severity).toBe('P1');
    expect((out[0]!.details as { last_run: string }).last_run).toBe(lastRun);
    expect((out[0]!.details as { max_age_hours: number }).max_age_hours).toBe(24);
    expect((out[0]!.details as { age_hours: number }).age_hours).toBeGreaterThan(24);
  });

  test('mixed: 2 stale + 1 fresh → 2 observations', async () => {
    await writeManifest(dataDir, {
      backups: [
        { id: 'fresh', last_run: new Date(NOW_MS - 60_000).toISOString(), max_age_hours: 24 },
        { id: 'stale-1', last_run: new Date(NOW_MS - 30 * 3_600_000).toISOString(), max_age_hours: 24 },
        { id: 'stale-2', last_run: new Date(NOW_MS - 50 * 3_600_000).toISOString(), max_age_hours: 24 },
      ],
    });
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    const out = await probe.scan();
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.resource).sort()).toEqual(['backup/stale-1', 'backup/stale-2']);
  });

  test('missing manifest → unreachable sentinel', async () => {
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.resource).toBe(`backup-manifest/${dataDir}`);
    expect(out[0]!.details).toMatchObject({ probe: 'backup-overdue' });
  });

  test('malformed manifest JSON → unreachable sentinel', async () => {
    await fs.writeFile(path.join(dataDir, 'backup-manifest.json'), 'not-json', 'utf8');
    const probe = new BackupOverdueProbe({ platformId: PLATFORM, dataDir, now: () => NOW_MS });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
  });
});
