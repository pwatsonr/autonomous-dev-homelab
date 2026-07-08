/**
 * Tests for the unified backup-manifest schema (#46).
 *
 * Covers:
 *   - `convertLegacyManifest` upgrades v1-verifier shape.
 *   - `convertLegacyManifest` upgrades v1-overdue-probe shape.
 *   - `convertLegacyManifest` returns v2 as-is.
 *   - `convertLegacyManifest` handles null / unknown input.
 *   - `signManifestEntry` / `verifyEntryHmac` round-trip.
 *   - Cross-consistency: a fresh verifiable entry NEVER emits `backup_overdue`.
 *   - Cross-consistency: a stale entry ALWAYS emits `backup_overdue`.
 */

import { convertLegacyManifest } from '../../src/backup/types';
import { signManifestEntry, verifyEntryHmac } from '../../src/backup/manifest-hmac';
import { BackupOverdueProbe } from '../../src/observation/probes/backup-overdue';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

describe('convertLegacyManifest', () => {
  it('returns empty v2 when given null', () => {
    const result = convertLegacyManifest(null);
    expect(result.schema_version).toBe(2);
    expect(result.entries).toHaveLength(0);
  });

  it('returns empty v2 when given an empty string', () => {
    const result = convertLegacyManifest('');
    expect(result.schema_version).toBe(2);
    expect(result.entries).toHaveLength(0);
  });

  it('returns v2 as-is when schema_version is already 2', () => {
    const v2 = {
      schema_version: 2 as const,
      entries: [
        {
          schema_version: 2 as const,
          platform: 'proxmox',
          target_id: 'pve-backup',
          backup_type: 'pve-backup',
          taken_at: '2026-01-01T00:00:00Z',
          location: '/b/x.tar',
          size_bytes: 100,
          max_age_seconds: 86400,
          checksum: '',
          verified: false,
          hmac: 'abc123',
        },
      ],
    };
    const result = convertLegacyManifest(v2);
    expect(result).toBe(v2); // same reference
    expect(result.entries[0]?.platform).toBe('proxmox');
  });

  it('upgrades a v1-verifier manifest (entries[] with platform field)', () => {
    const v1 = {
      entries: [
        {
          platform: 'truenas',
          backup_type: 'zfs-snapshot',
          taken_at: '2026-01-01T00:00:00Z',
          location: '/backups/truenas.tar',
          size_bytes: 512,
          hmac: 'deadbeef',
        },
      ],
    };
    const result = convertLegacyManifest(v1);
    expect(result.schema_version).toBe(2);
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0]!;
    expect(e.schema_version).toBe(2);
    expect(e.platform).toBe('truenas');
    expect(e.target_id).toBe('zfs-snapshot');
    expect(e.backup_type).toBe('zfs-snapshot');
    expect(e.taken_at).toBe('2026-01-01T00:00:00Z');
    expect(e.location).toBe('/backups/truenas.tar');
    expect(e.size_bytes).toBe(512);
    expect(e.max_age_seconds).toBe(86_400);
    expect(e.checksum).toBe('');
    expect(e.verified).toBe(false);
    expect(e.hmac).toBe('deadbeef');
  });

  it('upgrades a v1-overdue-probe manifest (backups[] with id/last_run)', () => {
    const v1 = {
      backups: [
        { id: 'restic-pg', last_run: '2026-06-01T00:00:00Z', max_age_hours: 48 },
      ],
    };
    const result = convertLegacyManifest(v1);
    expect(result.schema_version).toBe(2);
    expect(result.entries).toHaveLength(1);
    const e = result.entries[0]!;
    expect(e.schema_version).toBe(2);
    expect(e.target_id).toBe('restic-pg');
    expect(e.taken_at).toBe('2026-06-01T00:00:00Z');
    expect(e.max_age_seconds).toBe(48 * 3600);
    expect(e.platform).toBe('unknown');
    expect(e.hmac).toBe('');
  });

  it('handles mixed v1 manifest (entries + backups in same file)', () => {
    const mixed = {
      entries: [
        {
          platform: 'docker',
          backup_type: 'docker-volume',
          taken_at: '2026-06-01T00:00:00Z',
          location: '/b/vol.tar.gz',
          size_bytes: 256,
          hmac: 'aabbcc',
        },
      ],
      backups: [
        { id: 'restic-redis', last_run: '2026-06-01T00:00:00Z', max_age_hours: 24 },
      ],
    };
    const result = convertLegacyManifest(mixed);
    expect(result.entries).toHaveLength(2);
  });
});

describe('signManifestEntry / verifyEntryHmac', () => {
  let env: SafetyEnv;

  beforeEach(() => {
    env = setupSafetyEnv('manifest-hmac-test-');
  });
  afterEach(() => {
    teardownSafetyEnv(env);
  });

  const baseEntry = {
    schema_version: 2 as const,
    platform: 'postgres',
    target_id: 'mydb',
    backup_type: 'pg_dump',
    taken_at: '2026-06-01T00:00:00Z',
    location: '/backups/mydb.sql.gz',
    size_bytes: 4096,
    max_age_seconds: 86_400,
    checksum: 'abc123',
    verified: false,
  };

  it('signs and verifies a v2 entry successfully', () => {
    const signed = signManifestEntry(baseEntry);
    expect(typeof signed.hmac).toBe('string');
    expect(signed.hmac.length).toBe(64); // SHA-256 hex = 64 chars
    expect(verifyEntryHmac(signed)).toBe(true);
  });

  it('fails verification when hmac is tampered', () => {
    const signed = signManifestEntry(baseEntry);
    const tampered = {
      ...signed,
      hmac: signed.hmac.startsWith('a') ? 'b' + signed.hmac.slice(1) : 'a' + signed.hmac.slice(1),
    };
    expect(verifyEntryHmac(tampered)).toBe(false);
  });

  it('fails verification when payload is tampered', () => {
    const signed = signManifestEntry(baseEntry);
    const tampered = { ...signed, size_bytes: 99999 };
    expect(verifyEntryHmac(tampered)).toBe(false);
  });

  it('returns false for an empty hmac', () => {
    const unsigned = { ...baseEntry, hmac: '' };
    expect(verifyEntryHmac(unsigned)).toBe(false);
  });

  it('is deterministic — same payload → same hmac', () => {
    const a = signManifestEntry(baseEntry);
    const b = signManifestEntry(baseEntry);
    expect(a.hmac).toBe(b.hmac);
  });
});

describe('cross-consistency: verifyBackup vs BackupOverdueProbe', () => {
  let env: SafetyEnv;

  beforeEach(() => {
    env = setupSafetyEnv('cross-consistency-test-');
  });
  afterEach(() => {
    teardownSafetyEnv(env);
  });

  const NOW_MS = Date.now();

  async function writeV2Manifest(
    taken_at: string,
    max_age_seconds: number,
    dataDir: string,
  ): Promise<void> {
    const entry = signManifestEntry({
      schema_version: 2,
      platform: 'postgres',
      target_id: 'mydb',
      backup_type: 'pg_dump',
      taken_at,
      location: '/backups/mydb.sql.gz',
      size_bytes: 100,
      max_age_seconds,
      checksum: '',
      verified: false,
    });
    const manifest = { schema_version: 2, entries: [entry] };
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'backup-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  it('fresh entry: verifyBackup succeeds AND BackupOverdueProbe emits []', async () => {
    const taken_at = new Date(NOW_MS - 60_000).toISOString(); // 1 minute ago
    const dataDir = env.tmpDir;
    await writeV2Manifest(taken_at, 86_400, dataDir);

    // verifyBackup succeeds.
    const { verifyBackup } = await import('../../src/backup/orchestrator');
    const result = await verifyBackup({ platform: 'postgres', target: 'mydb' });
    expect(result.ok).toBe(true);

    // BackupOverdueProbe emits no alerts.
    const probe = new BackupOverdueProbe({
      platformId: 'homelab',
      dataDir,
      now: () => NOW_MS,
    });
    const obs = await probe.scan();
    expect(obs).toHaveLength(0);
  });

  it('stale entry: verifyBackup throws BackupRequiredError AND BackupOverdueProbe emits backup_overdue', async () => {
    const taken_at = new Date(NOW_MS - 50 * 3600 * 1000).toISOString(); // 50h ago
    const dataDir = env.tmpDir;
    await writeV2Manifest(taken_at, 86_400, dataDir);

    // verifyBackup throws.
    const { verifyBackup } = await import('../../src/backup/orchestrator');
    const { BackupRequiredError } = await import('../../src/safety/errors');
    await expect(verifyBackup({ platform: 'postgres', target: 'mydb' })).rejects.toBeInstanceOf(
      BackupRequiredError,
    );

    // BackupOverdueProbe emits 1 alert.
    const probe = new BackupOverdueProbe({
      platformId: 'homelab',
      dataDir,
      now: () => NOW_MS,
    });
    const obs = await probe.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pattern).toBe('backup_overdue');
    expect(obs[0]!.resource).toBe('backup/mydb');
  });
});
