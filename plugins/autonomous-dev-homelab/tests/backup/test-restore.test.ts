/**
 * Restore + DR runbook engine tests (#47).
 *
 * Covers:
 *   - `buildRestorePlan` produces the correct plan fields.
 *   - `buildDrRunbook` returns platform-specific text.
 *   - `dryRunRestore` checks artifact readability + target reachability (non-mutating).
 *   - `dryRunRestore` fails when the artifact is unreachable.
 *   - `runRestore` with dryRun=true does NOT invoke the gate or mutate anything.
 *   - `runRestore` with dryRun=false routes through the real gate.
 *   - Gate denial propagates correctly.
 *   - HMAC tamper in manifest entry causes dry-run to fail.
 */

import {
  buildRestorePlan,
  buildDrRunbook,
  dryRunRestore,
  runRestore,
} from '../../src/backup/restore';
import { signManifestEntry } from '../../src/backup/manifest-hmac';
import { gateApproval } from '../../src/safety/gate';
import { ApprovalDeniedError } from '../../src/safety/errors';
import type { BackupManifestEntry } from '../../src/backup/types';
import type { Connection, ExecResult } from '../../src/connection/base';
import type { GateContext, OperatorConfig, SafetyAuditEvent } from '../../src/safety/types';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';
import { __setPromptLine } from '../../src/safety/io-stdin';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeSignedEntry(
  overrides: Partial<Omit<BackupManifestEntry, 'hmac'>> = {},
): BackupManifestEntry {
  return signManifestEntry({
    schema_version: 2,
    platform: overrides.platform ?? 'postgres',
    target_id: overrides.target_id ?? 'mydb',
    backup_type: overrides.backup_type ?? 'pg_dump',
    taken_at: overrides.taken_at ?? '2026-06-01T00:00:00Z',
    location: overrides.location ?? '/backups/mydb.sql.gz',
    size_bytes: overrides.size_bytes ?? 4096,
    max_age_seconds: overrides.max_age_seconds ?? 86_400,
    checksum: overrides.checksum ?? '',
    verified: overrides.verified ?? false,
  });
}

interface MockExecMap {
  exact?: Map<string, { stdout: string; stderr: string; exitCode: number }>;
  fallback?: { stdout: string; stderr: string; exitCode: number };
}

function makeMockConnection(map: MockExecMap = {}): {
  conn: Connection;
  calls: string[];
} {
  const calls: string[] = [];
  const fallback = map.fallback ?? { stdout: 'ok', stderr: '', exitCode: 0 };
  const conn = {
    platformId: 'mock',
    isConnected: () => true,
    getCapabilities: () => undefined,
    getLastUsedAt: () => Date.now(),
    connect: async () => undefined,
    disconnect: async () => undefined,
    async exec(cmd: string): Promise<ExecResult> {
      calls.push(cmd);
      const exact = map.exact?.get(cmd);
      if (exact !== undefined) return { ...exact, durationMs: 1 };
      return { ...fallback, durationMs: 1 };
    },
  } as unknown as Connection;
  return { conn, calls };
}

function buildGateCtx(
  opts: { isAdmin?: boolean; confirmAnswer?: string } = {},
): GateContext {
  const auditEvents: SafetyAuditEvent[] = [];
  return {
    config: {
      auto_approval: {
        'read-only': 'L3',
        reversible: 'L0',
        'persistent-modifying': 'L0',
        'data-affecting': 'L0',
        architectural: 'L0',
      },
      typed_confirm_ttl_seconds: 60,
    } as OperatorConfig,
    isAdmin: () => opts.isAdmin ?? false,
    audit: async (e: SafetyAuditEvent) => { auditEvents.push(e); },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let env: SafetyEnv;
beforeEach(() => {
  env = setupSafetyEnv('restore-test-');
});
afterEach(() => {
  teardownSafetyEnv(env);
  __setPromptLine(undefined);
});

// ---------------------------------------------------------------------------
// buildRestorePlan
// ---------------------------------------------------------------------------

describe('buildRestorePlan', () => {
  it('returns plan with correct artifact, platform, targetId', () => {
    const entry = makeSignedEntry({ platform: 'postgres', target_id: 'mydb' });
    const plan = buildRestorePlan(entry);
    expect(plan.artifactPath).toBe('/backups/mydb.sql.gz');
    expect(plan.platform).toBe('postgres');
    expect(plan.targetId).toBe('mydb');
    expect(plan.takenAt).toBe('2026-06-01T00:00:00Z');
    expect(plan.sizeBytes).toBe(4096);
  });

  it('includes overwriteDescription mentioning the target', () => {
    const entry = makeSignedEntry({ platform: 'redis', target_id: 'cache' });
    const plan = buildRestorePlan(entry);
    expect(plan.overwriteDescription).toContain('cache');
    expect(plan.overwriteDescription).toContain('redis');
  });

  it('includes expectedDowntime for known platforms', () => {
    const pg = buildRestorePlan(makeSignedEntry({ platform: 'postgres' }));
    expect(pg.expectedDowntime).toContain('minute');
    const redis = buildRestorePlan(makeSignedEntry({ platform: 'redis' }));
    expect(redis.expectedDowntime).toContain('minute');
  });

  it('includes drRunbook text', () => {
    const plan = buildRestorePlan(makeSignedEntry({ platform: 'postgres' }));
    expect(plan.drRunbook).toContain('DR Runbook');
    expect(plan.drRunbook).toContain('PostgreSQL');
  });
});

// ---------------------------------------------------------------------------
// buildDrRunbook
// ---------------------------------------------------------------------------

describe('buildDrRunbook', () => {
  it('returns postgres-specific runbook for postgres platform', () => {
    const entry = makeSignedEntry({ platform: 'postgres', target_id: 'mydb' });
    const rb = buildDrRunbook('postgres', entry);
    expect(rb).toContain('pg_restore');
    expect(rb).toContain('mydb');
  });

  it('returns redis-specific runbook for redis platform', () => {
    const entry = makeSignedEntry({ platform: 'redis', target_id: 'cache' });
    const rb = buildDrRunbook('redis', entry);
    expect(rb).toContain('RDB');
    expect(rb).toContain('systemctl stop redis');
  });

  it('returns proxmox runbook for proxmox platform', () => {
    const entry = makeSignedEntry({ platform: 'proxmox', target_id: '100' });
    const rb = buildDrRunbook('proxmox', entry);
    expect(rb).toContain('qmrestore');
  });

  it('returns vault runbook for vault-raft platform', () => {
    const entry = makeSignedEntry({ platform: 'vault-raft', target_id: 'vault' });
    const rb = buildDrRunbook('vault-raft', entry);
    expect(rb).toContain('raft snapshot restore');
  });

  it('returns generic runbook for unknown platform', () => {
    const entry = makeSignedEntry({ platform: 'my-custom-db', target_id: 'x' });
    const rb = buildDrRunbook('my-custom-db', entry);
    expect(rb).toContain('DR Runbook');
    expect(rb).toContain('my-custom-db');
  });
});

// ---------------------------------------------------------------------------
// dryRunRestore
// ---------------------------------------------------------------------------

describe('dryRunRestore', () => {
  it('returns ok=true when artifact readable and target reachable', async () => {
    const entry = makeSignedEntry();
    const { conn } = makeMockConnection({
      exact: new Map([
        [`stat ${entry.location}`, { stdout: 'ok', stderr: '', exitCode: 0 }],
        ['echo ok', { stdout: 'ok', stderr: '', exitCode: 0 }],
      ]),
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
    const result = await dryRunRestore(entry, conn);
    expect(result.ok).toBe(true);
    expect(result.artifactReadable).toBe(true);
    expect(result.targetReachable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns ok=false when artifact is unreadable', async () => {
    const entry = makeSignedEntry();
    const { conn } = makeMockConnection({
      exact: new Map([
        [`stat ${entry.location}`, { stdout: '', stderr: 'no such file', exitCode: 1 }],
        ['echo ok', { stdout: 'ok', stderr: '', exitCode: 0 }],
      ]),
    });
    const result = await dryRunRestore(entry, conn);
    expect(result.ok).toBe(false);
    expect(result.artifactReadable).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns ok=false when target is unreachable', async () => {
    const entry = makeSignedEntry();
    const { conn } = makeMockConnection({
      exact: new Map([
        [`stat ${entry.location}`, { stdout: 'ok', stderr: '', exitCode: 0 }],
        ['echo ok', { stdout: 'FAIL', stderr: '', exitCode: 1 }],
      ]),
    });
    const result = await dryRunRestore(entry, conn);
    expect(result.ok).toBe(false);
    expect(result.targetReachable).toBe(false);
  });

  it('does NOT execute any restore commands (non-mutating)', async () => {
    const entry = makeSignedEntry({ platform: 'postgres' });
    const { conn, calls } = makeMockConnection({
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
    await dryRunRestore(entry, conn);

    // Should not have called any restore-specific commands.
    const mutateCmds = ['pg_restore', 'psql', 'systemctl stop', 'docker run', 'zfs receive', 'vault operator raft snapshot restore'];
    for (const cmd of mutateCmds) {
      expect(calls.some((c) => c.includes(cmd))).toBe(false);
    }
  });

  it('fails when HMAC is tampered', async () => {
    const valid = makeSignedEntry();
    const tampered: BackupManifestEntry = {
      ...valid,
      hmac: valid.hmac.startsWith('a') ? 'b' + valid.hmac.slice(1) : 'a' + valid.hmac.slice(1),
    };
    const { conn } = makeMockConnection({
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
    const result = await dryRunRestore(tampered, conn);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /HMAC|tamper/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runRestore (gated)
// ---------------------------------------------------------------------------

describe('runRestore', () => {
  it('dry-run=true returns ok without invoking the gate or mutating', async () => {
    const entry = makeSignedEntry();
    const { conn, calls } = makeMockConnection({
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });

    // We should NOT see any typed-CONFIRM or gate call.
    const gateCallSpy = jest.spyOn(require('../../src/safety/gate'), 'gateApproval');

    const result = await runRestore({
      entry,
      connection: conn,
      gateContext: buildGateCtx(),
      actionId: 'act-test-dryrun',
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(false);
    expect(gateCallSpy).not.toHaveBeenCalled();
    gateCallSpy.mockRestore();
  });

  it('dry-run=false routes through the real gate (typed-CONFIRM)', async () => {
    const entry = makeSignedEntry({ platform: 'filesystem', target_id: 'myfs' });
    const { conn, calls } = makeMockConnection({
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });

    // Inject typed-CONFIRM answer "CONFIRM" to approve.
    __setPromptLine(async () => 'CONFIRM');

    // We also need a fresh backup in the manifest for the gate's backup-check.
    // Use skipBackupCheck via admin=true to sidestep the backup gate in this test
    // (the gate+backup combo is tested in gate.test.ts).
    const gateCtx: GateContext = {
      ...buildGateCtx({ isAdmin: true }),
      flags: { skipBackupCheck: true },
    };

    const result = await runRestore({
      entry,
      connection: conn,
      gateContext: gateCtx,
      actionId: 'act-test-restore-gated',
      dryRun: false,
      requestedBy: 'test-operator',
    });

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(true);

    // A restore command was executed (mkdir + tar for filesystem).
    expect(calls.some((c) => c.includes('tar xzf') || c.includes('mkdir'))).toBe(true);
  });

  it('throws when dry-run fails (bad artifact)', async () => {
    const entry = makeSignedEntry();
    const { conn } = makeMockConnection({
      exact: new Map([
        [`stat ${entry.location}`, { stdout: '', stderr: 'no such file', exitCode: 1 }],
        ['echo ok', { stdout: 'ok', stderr: '', exitCode: 0 }],
      ]),
    });

    await expect(
      runRestore({
        entry,
        connection: conn,
        gateContext: buildGateCtx({ isAdmin: true }),
        actionId: 'act-bad-artifact',
        dryRun: true,
      }),
    ).rejects.toThrow(/dry-run failed/);
  });

  it('gate denial propagates as ApprovalDeniedError', async () => {
    const entry = makeSignedEntry({ platform: 'filesystem', target_id: 'x' });
    const { conn } = makeMockConnection({
      fallback: { stdout: 'ok', stderr: '', exitCode: 0 },
    });

    // Inject "WRONG" typed-CONFIRM answer — gate will deny.
    __setPromptLine(async () => 'WRONG');

    const gateCtx: GateContext = {
      ...buildGateCtx({ isAdmin: true }),
      flags: { skipBackupCheck: true },
    };

    await expect(
      runRestore({
        entry,
        connection: conn,
        gateContext: gateCtx,
        actionId: 'act-denied',
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(ApprovalDeniedError);
  });
});
