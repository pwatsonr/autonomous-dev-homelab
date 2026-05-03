/**
 * `verifyBackup` tests. SPEC-002-2-05.
 *
 * Covers:
 *   - missing manifest → BackupRequiredError;
 *   - fresh manifest → ok + entry returned;
 *   - stale manifest → BackupRequiredError with age in message;
 *   - tampered manifest → throws (NOT BackupRequiredError);
 *   - freshness override accepted;
 *   - freshest of multiple entries selected.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { verifyBackup } from '../../src/backup/orchestrator';
import { BackupRequiredError } from '../../src/safety/errors';
import {
  writeFreshBackupManifest,
  writeStaleBackupManifest,
  writeTamperedBackupManifest,
  writeBackupManifest,
  signBackupEntry,
} from '../helpers/backup-manifest';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';

describe('verifyBackup', () => {
  let env: SafetyEnv;

  beforeEach(() => {
    env = setupSafetyEnv('backup-test-');
  });

  afterEach(() => {
    teardownSafetyEnv(env);
  });

  it('throws BackupRequiredError when the manifest file is missing', async () => {
    await expect(
      verifyBackup({ platform: 'proxmox', target: 'pve-1' }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('throws BackupRequiredError when no entries match the requested platform', async () => {
    await writeFreshBackupManifest('proxmox');
    await expect(
      verifyBackup({ platform: 'truenas', target: 'tank' }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('returns ok + entry for a fresh manifest', async () => {
    await writeFreshBackupManifest('proxmox');
    const result = await verifyBackup({ platform: 'proxmox', target: 'pve-1' });
    expect(result.ok).toBe(true);
    expect(result.entry.platform).toBe('proxmox');
  });

  it('throws BackupRequiredError with age info when the manifest is stale', async () => {
    await writeStaleBackupManifest('proxmox', 48);
    let thrown: unknown;
    try {
      await verifyBackup({ platform: 'proxmox', target: 'pve-1' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BackupRequiredError);
    expect((thrown as Error).message).toMatch(/stale/);
  });

  it('throws (NOT BackupRequiredError) when an entry has a broken HMAC', async () => {
    await writeTamperedBackupManifest('proxmox');
    let thrown: unknown;
    try {
      await verifyBackup({ platform: 'proxmox', target: 'pve-1' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(BackupRequiredError);
    expect((thrown as Error).message).toMatch(/Tampered/);
  });

  it('honors a per-platform freshness override', async () => {
    // 48h-old entry. Default proxmox freshness is 24h → would fail.
    await writeStaleBackupManifest('proxmox', 48);
    const result = await verifyBackup({
      platform: 'proxmox',
      target: 'pve-1',
      freshnessOverrides: { proxmox: 7 * 86_400 },
    });
    expect(result.ok).toBe(true);
  });

  it('selects the freshest entry when multiple exist for the same platform', async () => {
    const stale = signBackupEntry({
      platform: 'proxmox',
      backup_type: 'pve-backup',
      taken_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      location: '/backups/proxmox/old.tar',
      size_bytes: 1,
    });
    const fresh = signBackupEntry({
      platform: 'proxmox',
      backup_type: 'pve-backup',
      taken_at: new Date(Date.now() - 60_000).toISOString(),
      location: '/backups/proxmox/new.tar',
      size_bytes: 2,
    });
    await writeBackupManifest([stale, fresh]);
    const result = await verifyBackup({ platform: 'proxmox', target: 'pve-1' });
    expect(result.entry.location).toBe('/backups/proxmox/new.tar');
  });

  it('returns BackupRequiredError when the manifest file exists but has no entries', async () => {
    const dir = process.env['HOMELAB_DATA_DIR']!;
    await fs.writeFile(path.join(dir, 'backup-manifest.json'), JSON.stringify({ entries: [] }));
    await expect(
      verifyBackup({ platform: 'proxmox', target: 'pve-1' }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });
});
