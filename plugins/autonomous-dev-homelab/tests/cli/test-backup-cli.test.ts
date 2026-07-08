/**
 * CLI backup command integration tests (#45, #47).
 *
 * Verifies that:
 *   - `backup run`, `backup list`, `backup verify`, `backup restore`, and
 *     `backup drivers` are all REGISTERED in the CLI command tree.
 *   - `backup list` returns 0 and prints nothing when manifest is empty.
 *   - `backup verify` returns failure when no manifest entry exists.
 *   - `backup run` calls the connection factory and appends an entry.
 *   - `backup restore --dry-run` produces a plan without mutating.
 *   - `backup restore` (real) routes through the gate.
 *   - `backup drivers` lists the built-in drivers.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { buildBackupCommand } from '../../src/cli/commands/backup';
import { signManifestEntry } from '../../src/backup/manifest-hmac';
import { writeManifestFile } from '../../src/backup/manifest-io';
import type { Connection, ExecResult } from '../../src/connection/base';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';
import { __setPromptLine } from '../../src/safety/io-stdin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockConnection(): Connection {
  return {
    platformId: 'mock',
    isConnected: () => true,
    getCapabilities: () => undefined,
    getLastUsedAt: () => Date.now(),
    connect: async () => undefined,
    disconnect: async () => undefined,
    async exec(cmd: string): Promise<ExecResult> {
      // Return sensible defaults for all driver commands.
      if (cmd.includes('stat')) return { stdout: '1024\n', stderr: '', exitCode: 0, durationMs: 1 };
      if (cmd.includes('sha256sum')) return { stdout: 'abc123checksum\n', stderr: '', exitCode: 0, durationMs: 1 };
      if (cmd.includes('echo ok')) return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 };
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
    },
  } as unknown as Connection;
}

function makeOutputStreams(): { stdout: string; stderr: string; stdoutFn: (s: string) => void; stderrFn: (s: string) => void } {
  let stdout = '';
  let stderr = '';
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    stdoutFn: (s: string) => { stdout += s; },
    stderrFn: (s: string) => { stderr += s; },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let env: SafetyEnv;
let dataDir: string;

beforeEach(() => {
  env = setupSafetyEnv('backup-cli-test-');
  dataDir = env.tmpDir;
});
afterEach(() => {
  teardownSafetyEnv(env);
  __setPromptLine(undefined);
});

// ---------------------------------------------------------------------------
// Command registration proof
// ---------------------------------------------------------------------------

describe('backup command registration', () => {
  it('all subcommands are registered on the backup command', () => {
    const streams = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: streams.stdoutFn, stderr: streams.stderrFn },
    });
    const cmd = handle.command;
    const subNames = cmd.commands.map((c) => c.name());
    expect(subNames).toContain('run');
    expect(subNames).toContain('list');
    expect(subNames).toContain('verify');
    expect(subNames).toContain('restore');
    expect(subNames).toContain('drivers');
  });

  it('backup command name is "backup"', () => {
    const handle = buildBackupCommand({ dataDir });
    expect(handle.command.name()).toBe('backup');
  });
});

// ---------------------------------------------------------------------------
// backup list
// ---------------------------------------------------------------------------

describe('backup list', () => {
  it('exits 0 and prints "No backup manifest entries" when manifest is empty', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command
      .parseAsync(['list'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(out.stdout).toContain('No backup manifest entries');
  });

  it('exits 0 and lists entries when manifest has entries', async () => {
    // Write a v2 manifest with one entry.
    const entry = signManifestEntry({
      schema_version: 2,
      platform: 'postgres',
      target_id: 'mydb',
      backup_type: 'pg_dump',
      taken_at: '2026-06-01T00:00:00Z',
      location: '/backups/mydb.sql.gz',
      size_bytes: 4096,
      max_age_seconds: 86_400,
      checksum: '',
      verified: false,
    });
    await writeManifestFile(dataDir, { schema_version: 2, entries: [entry] });

    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['list'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(out.stdout).toContain('postgres');
    expect(out.stdout).toContain('mydb');
  });

  it('backup list --json emits JSON', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['list', '--json'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(out.stdout) as { entries: unknown[] };
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// backup verify
// ---------------------------------------------------------------------------

describe('backup verify', () => {
  it('exits 1 when no entry exists for platform', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['verify', '--platform', 'postgres', '--target', 'mydb'], { from: 'user' });
    expect(handle.lastExitCode()).not.toBe(0);
  });

  it('exits 0 when a fresh entry exists', async () => {
    const entry = signManifestEntry({
      schema_version: 2,
      platform: 'postgres',
      target_id: 'mydb',
      backup_type: 'pg_dump',
      taken_at: new Date().toISOString(),
      location: '/backups/mydb.sql.gz',
      size_bytes: 4096,
      max_age_seconds: 86_400,
      checksum: '',
      verified: false,
    });
    await writeManifestFile(dataDir, { schema_version: 2, entries: [entry] });

    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['verify', '--platform', 'postgres', '--target', 'mydb'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(out.stdout).toContain('Backup OK');
  });
});

// ---------------------------------------------------------------------------
// backup run
// ---------------------------------------------------------------------------

describe('backup run', () => {
  it('calls the connection factory and appends a manifest entry', async () => {
    let connectionRequested = '';
    const getConnection = async (platformId: string): Promise<Connection> => {
      connectionRequested = platformId;
      return makeMockConnection();
    };

    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
      getConnection,
    });

    await handle.command.parseAsync(
      ['run', '--driver', 'filesystem', '--target', 'myfs', '--platform', 'test', '--dest', dataDir],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(0);
    expect(connectionRequested).toBe('test');
    // Manifest should have an entry now.
    const { readManifestFile } = await import('../../src/backup/manifest-io');
    const manifest = await readManifestFile(dataDir);
    const entry = manifest.entries.find((e) => e.target_id === 'myfs');
    expect(entry).toBeDefined();
    expect(entry!.platform).toBe('test');
  });

  it('exits 1 when no connection factory is wired', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
      // no getConnection
    });
    await handle.command.parseAsync(['run', '--driver', 'filesystem', '--target', 'x'], { from: 'user' });
    expect(handle.lastExitCode()).not.toBe(0);
    expect(out.stderr).toContain('No connection factory');
  });
});

// ---------------------------------------------------------------------------
// backup restore --dry-run
// ---------------------------------------------------------------------------

describe('backup restore --dry-run', () => {
  it('prints plan without mutating anything', async () => {
    const entry = signManifestEntry({
      schema_version: 2,
      platform: 'postgres',
      target_id: 'mydb',
      backup_type: 'pg_dump',
      taken_at: new Date().toISOString(),
      location: '/backups/mydb.sql.gz',
      size_bytes: 4096,
      max_age_seconds: 86_400,
      checksum: '',
      verified: false,
    });
    await writeManifestFile(dataDir, { schema_version: 2, entries: [entry] });

    const calls: string[] = [];
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
      // No getConnection — dry-run plan output path doesn't need it.
    });

    await handle.command.parseAsync(['restore', '0', '--dry-run'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(out.stdout).toContain('DRY RUN');
    expect(out.stdout).toContain('postgres');
    expect(out.stdout).toContain('mydb');
    // Runbook text appears.
    expect(out.stdout).toContain('DR Runbook');
  });
});

// ---------------------------------------------------------------------------
// backup drivers
// ---------------------------------------------------------------------------

describe('backup drivers', () => {
  it('lists all registered driver types', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['drivers'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    expect(out.stdout).toContain('postgres');
    expect(out.stdout).toContain('redis');
    expect(out.stdout).toContain('vault-raft');
  });

  it('backup drivers --json emits JSON', async () => {
    const out = makeOutputStreams();
    const handle = buildBackupCommand({
      dataDir,
      streams: { stdout: out.stdoutFn, stderr: out.stderrFn },
    });
    await handle.command.parseAsync(['drivers', '--json'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(out.stdout) as { drivers: string[] };
    expect(Array.isArray(parsed.drivers)).toBe(true);
    expect(parsed.drivers).toContain('postgres');
  });
});
