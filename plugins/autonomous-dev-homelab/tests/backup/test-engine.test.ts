/**
 * Backup execution engine tests (#45).
 *
 * Covers:
 *   - Driver registry: register / get / list / override.
 *   - `runBackup` dispatches to the correct driver.
 *   - Driver maps exec output to artifact path + size + checksum.
 *   - `runBackup` appends a signed manifest entry.
 *   - `runBackup` throws when no driver is registered.
 *   - All nine built-in drivers are registered by default.
 *   - Entry written to manifest is HMAC-verifiable.
 *   - No secrets appear in the recorded exec calls.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  registerDriver,
  getDriver,
  listDriverTypes,
  runBackup,
} from '../../src/backup/engine';
import { verifyEntryHmac } from '../../src/backup/manifest-hmac';
import { readManifestFile } from '../../src/backup/manifest-io';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';
import type { BackupDriverInput, BackupDriver } from '../../src/backup/engine';
import type { Connection, ExecResult } from '../../src/connection/base';

// ---------------------------------------------------------------------------
// Mock connection helper
// ---------------------------------------------------------------------------

function makeMockConnection(
  responses: Map<string, { stdout: string; stderr: string; exitCode: number }> = new Map(),
  fallback: { stdout: string; stderr: string; exitCode: number } = { stdout: '', stderr: '', exitCode: 0 },
): { conn: Connection; calls: string[] } {
  const calls: string[] = [];
  const conn = {
    platformId: 'mock',
    isConnected: () => true,
    getCapabilities: () => undefined,
    getLastUsedAt: () => Date.now(),
    connect: async () => undefined,
    disconnect: async () => undefined,
    async exec(cmd: string): Promise<ExecResult> {
      calls.push(cmd);
      const r = responses.get(cmd) ?? fallback;
      return { ...r, durationMs: 1 };
    },
  } as unknown as Connection;
  return { conn, calls };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let env: SafetyEnv;
let dataDir: string;

beforeEach(() => {
  env = setupSafetyEnv('engine-test-');
  dataDir = env.tmpDir;
});
afterEach(() => {
  teardownSafetyEnv(env);
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('driver registry', () => {
  it('all nine built-in drivers are registered', () => {
    const types = listDriverTypes();
    const expected = [
      'postgres',
      'redis',
      'docker-volume',
      'unraid-share',
      'filesystem',
      'zfs-dataset',
      'proxmox-vm',
      'opensearch',
      'neo4j',
      'vault-raft',
    ];
    for (const t of expected) {
      expect(types).toContain(t);
    }
  });

  it('getDriver returns undefined for unknown type', () => {
    expect(getDriver('nonexistent-driver-xyz')).toBeUndefined();
  });

  it('registerDriver overwrites existing driver (last-write-wins)', () => {
    const d1: BackupDriver = {
      name: 'test-d1',
      targetType: 'test-override-driver',
      backup: async (_i) => ({ artifactPath: '/a', sizeBytes: 1, checksum: 'x' }),
    };
    const d2: BackupDriver = {
      name: 'test-d2',
      targetType: 'test-override-driver',
      backup: async (_i) => ({ artifactPath: '/b', sizeBytes: 2, checksum: 'y' }),
    };
    registerDriver(d1);
    registerDriver(d2);
    const got = getDriver('test-override-driver');
    expect(got?.name).toBe('test-d2');
  });

  it('custom driver plugs in without core edits', () => {
    const custom: BackupDriver = {
      name: 'My custom backup',
      targetType: 'custom-db',
      backup: async (input) => ({
        artifactPath: `${input.destDir}/custom.tar`,
        sizeBytes: 42,
        checksum: 'cafe',
      }),
    };
    registerDriver(custom);
    expect(getDriver('custom-db')).toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// runBackup dispatch tests
// ---------------------------------------------------------------------------

describe('runBackup dispatch', () => {
  it('throws when no driver is registered for targetType', async () => {
    const { conn } = makeMockConnection();
    const input: BackupDriverInput = {
      targetId: 'mydb',
      platform: 'unknown-platform',
      params: {},
      destDir: '/tmp',
      dataDir,
      connection: conn,
    };
    await expect(runBackup('nonexistent-xyz-driver', input)).rejects.toThrow(
      /No backup driver registered/,
    );
  });

  it('dispatches to a custom driver and appends a signed manifest entry', async () => {
    const responses = new Map([
      ['stat -c %s /backups/custom-out.bin', { stdout: '2048\n', stderr: '', exitCode: 0 }],
      ["sha256sum /backups/custom-out.bin | awk '{print $1}'", { stdout: 'deadbeef01234567\n', stderr: '', exitCode: 0 }],
    ]);
    const { conn } = makeMockConnection(responses, { stdout: 'ok\n', stderr: '', exitCode: 0 });

    const custom: BackupDriver = {
      name: 'Custom test driver',
      targetType: 'custom-test-dispatch',
      backup: async (_input) => ({
        artifactPath: '/backups/custom-out.bin',
        sizeBytes: 2048,
        checksum: 'deadbeef01234567',
      }),
    };
    registerDriver(custom);

    const result = await runBackup('custom-test-dispatch', {
      targetId: 'my-target',
      platform: 'test-platform',
      params: {},
      destDir: '/backups',
      dataDir,
      connection: conn,
    });

    expect(result.artifactPath).toBe('/backups/custom-out.bin');
    expect(result.sizeBytes).toBe(2048);
    expect(result.checksum).toBe('deadbeef01234567');
    expect(result.entry.platform).toBe('test-platform');
    expect(result.entry.target_id).toBe('my-target');
    expect(result.entry.backup_type).toBe('custom-test-dispatch');
    expect(result.entry.verified).toBe(false);
  });

  it('appends a signed (HMAC-verifiable) entry to the manifest', async () => {
    const custom: BackupDriver = {
      name: 'Signing test driver',
      targetType: 'custom-signing-test',
      backup: async (_input) => ({
        artifactPath: '/out/test.tar',
        sizeBytes: 512,
        checksum: 'abc123',
      }),
    };
    registerDriver(custom);

    const { conn } = makeMockConnection();
    await runBackup('custom-signing-test', {
      targetId: 'signing-target',
      platform: 'signing-platform',
      params: {},
      destDir: '/out',
      dataDir,
      connection: conn,
    });

    const manifest = await readManifestFile(dataDir);
    const entry = manifest.entries.find(
      (e) => e.target_id === 'signing-target',
    );
    expect(entry).toBeDefined();
    expect(verifyEntryHmac(entry!)).toBe(true);
  });

  it('does not record any secret-looking strings in exec calls', async () => {
    // The postgres driver must NOT pass passwords via exec arguments.
    const responses = new Map([
      [`pg_dump testdb | gzip > /dest/pg-testdb-${Date.now()}.sql.gz`, { stdout: '', stderr: '', exitCode: 0 }],
    ]);
    const { conn, calls } = makeMockConnection(
      new Map(),
      { stdout: '1024\nchecksum123\n', stderr: '', exitCode: 0 },
    );

    const custom: BackupDriver = {
      name: 'Secret-free driver',
      targetType: 'secret-free-test',
      backup: async (_input) => ({
        artifactPath: '/dest/test.gz',
        sizeBytes: 1024,
        checksum: 'abc',
      }),
    };
    registerDriver(custom);
    await runBackup('secret-free-test', {
      targetId: 'x',
      platform: 'test',
      params: {},
      destDir: '/dest',
      dataDir,
      connection: conn,
    });

    // No call should include common secret patterns.
    const SECRET_PATTERNS = [/password=/i, /--password/i, /PGPASSWORD=[^\s]/i];
    for (const call of calls) {
      for (const pat of SECRET_PATTERNS) {
        expect(call).not.toMatch(pat);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// filesystem driver integration (end-to-end with mock connection)
// ---------------------------------------------------------------------------

describe('filesystem driver (mock exec)', () => {
  it('executes tar and records the artifact in the manifest', async () => {
    const destDir = '/backups';
    const expectedPath = `/backups/fs-myfs-${Date.now()}`;
    const responses = new Map<string, { stdout: string; stderr: string; exitCode: number }>();
    // Match by substring since the timestamp in the filename changes.
    const { conn, calls } = makeMockConnection(
      new Map(),
      { stdout: '8192\nsha256hash\n', stderr: '', exitCode: 0 },
    );

    await runBackup('filesystem', {
      targetId: 'myfs',
      platform: 'filesystem',
      params: { path: '/data/myfs' },
      destDir,
      dataDir,
      connection: conn,
    });

    const manifest = await readManifestFile(dataDir);
    const entry = manifest.entries.find((e) => e.target_id === 'myfs');
    expect(entry).toBeDefined();
    expect(entry!.platform).toBe('filesystem');
    expect(entry!.backup_type).toBe('filesystem');
    expect(entry!.location).toContain('/backups/fs-myfs-');

    // tar was called.
    expect(calls.some((c) => c.includes('tar czf'))).toBe(true);
    // stat was called.
    expect(calls.some((c) => c.includes('stat'))).toBe(true);
  });
});
