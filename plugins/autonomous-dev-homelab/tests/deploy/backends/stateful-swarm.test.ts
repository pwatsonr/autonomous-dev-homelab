/**
 * Stateful-aware DockerSwarmHomelabBackend tests (issue #33).
 *
 * Verifies:
 *   1. Stateful target (role=database / named_volumes) with a fresh verified
 *      backup → deploy proceeds, stateful=true in the record.
 *   2. Stateful target with no backup → deploy BLOCKED (BackupRequiredError
 *      propagates before any docker command is issued).
 *   3. Stateful target with a stale backup → deploy BLOCKED.
 *   4. Named volumes are NOT removed during a stateful redeploy
 *      (no `docker volume rm` command is issued).
 *   5. Stateless deploy (no role, no volumes) → deploy proceeds without
 *      calling verifyBackup at all.
 *   6. Backup gate is skipped when requireBackup=false (admin bypass path).
 *   7. record.payload.stateful flag is set correctly (true / false / absent).
 *
 * All tests mock connections and verifyBackup — no network or filesystem.
 */

import { ensureHmacSecret } from '../../helpers/hmac-secret';
import {
  mockDockerSwarmConnection,
  type MockConnection,
} from '../../helpers/mock-connections';

import {
  DockerSwarmHomelabBackend,
} from '../../../src/deploy/backends/docker-swarm';
import { BackupRequiredError } from '../../../src/safety/errors';
import type { DeployParameters, BuildContext } from '../../../src/deploy/types';
import type { VerifyBackupFn } from '../../../src/deploy/backends/docker-swarm';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseParams: DeployParameters = {
  manager_id: 'swarm-mgr',
  stack_name: 'mystack',
  compose_file_path: 'deploy/mystack.yml',
  image_uri: 'ghcr.io/owner/myapp:2.0.0',
  service_name: 'svc',
};

const statefulParamsByRole: DeployParameters = {
  ...baseParams,
  role: 'database',
  backup_platform: 'postgres',
};

const statefulParamsByVolume: DeployParameters = {
  ...baseParams,
  named_volumes: ['pg-data'],
  backup_platform: 'docker',
};

const statelessParams: DeployParameters = {
  ...baseParams,
  // no role, no named_volumes → stateless
};

function mkCtx(params: DeployParameters = statelessParams): BuildContext {
  return {
    requestId: 'req-stateful',
    envName: 'prod',
    repoPath: '/repo',
    commitSha: 'deadbeef01',
    params: { ...params },
  };
}

/** Returns a swarm exec-map that succeeds for all standard operations. */
function happyExecMap(): Parameters<typeof mockDockerSwarmConnection>[0] {
  return {
    patterns: [
      {
        match: 'docker service inspect',
        result: { stdout: '', stderr: 'no such service', exitCode: 1 },
      },
      {
        match: 'docker stack deploy',
        result: { stdout: 'Updating service mystack_svc', stderr: '', exitCode: 0 },
      },
    ],
    fallback: { stdout: '', stderr: '', exitCode: 0 },
  };
}

/** A mock verifyBackup that always succeeds (fresh backup exists). */
const freshBackupVerifier: VerifyBackupFn = async (input) => ({
  ok: true,
  entry: {
    schema_version: 2,
    platform: input.platform,
    target_id: input.target,
    backup_type: `${input.platform}-backup`,
    taken_at: new Date().toISOString(),
    location: `/backups/${input.platform}/latest.tar`,
    size_bytes: 1024,
    max_age_seconds: 86_400,
    checksum: '',
    verified: false,
    hmac: 'mock-hmac',
  },
});

/** A mock verifyBackup that always rejects (no fresh backup). */
const missingBackupVerifier: VerifyBackupFn = async (input) => {
  throw new BackupRequiredError(input.target, input.platform);
};

/** A mock verifyBackup that rejects with a stale-backup message. */
const staleBackupVerifier: VerifyBackupFn = async (input) => {
  throw new BackupRequiredError(
    input.target,
    `${input.platform} (stale: 48h old, limit 24h)`,
  );
};

function makeBackend(
  conn: MockConnection,
  verifyBackup: VerifyBackupFn = freshBackupVerifier,
  opts: { requireBackup?: boolean } = {},
): DockerSwarmHomelabBackend {
  let counter = 0;
  return new DockerSwarmHomelabBackend({
    getConnection: async () => conn,
    sleep: async () => undefined,
    now: () => 1700000000000,
    generateId: () => `swarm-sf-${++counter}`,
    verifyBackup,
    ...(opts.requireBackup !== undefined
      ? { statefulConfig: { requireBackup: opts.requireBackup } }
      : {}),
  });
}

beforeAll(() => {
  ensureHmacSecret();
});

// ---------------------------------------------------------------------------
// Stateful deploy — happy path (fresh backup + volume preservation)
// ---------------------------------------------------------------------------

describe('Stateful deploy — fresh backup', () => {
  it('proceeds when role=database and a fresh backup exists', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    expect(record.payload.stateful).toBe(true);
    expect(record.payload.details['backup_platform']).toBe('postgres');
    // Docker deploy command was issued.
    const deployed = conn.recordedCalls.some(
      (c) => c.op === 'exec' && (c.args[0] as string).startsWith('docker stack deploy'),
    );
    expect(deployed).toBe(true);
  });

  it('proceeds when named_volumes is non-empty and a fresh backup exists', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByVolume));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByVolume });

    expect(record.payload.stateful).toBe(true);
  });

  it('calls verifyBackup with the correct platform before deploying', async () => {
    const calls: Array<{ platform: string; target: string }> = [];
    const capturingVerifier: VerifyBackupFn = async (input) => {
      calls.push({ platform: input.platform, target: input.target });
      return freshBackupVerifier(input);
    };
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, capturingVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.platform).toBe('postgres');
    expect(calls[0]?.target).toBe('mystack_svc');
  });

  it('calls verifyBackup BEFORE issuing docker stack deploy', async () => {
    const callOrder: string[] = [];
    const orderingVerifier: VerifyBackupFn = async (input) => {
      callOrder.push('verifyBackup');
      return freshBackupVerifier(input);
    };
    const conn = mockDockerSwarmConnection(happyExecMap());
    const originalExec = conn.exec.bind(conn);
    conn.exec = async (cmd: string) => {
      if (cmd.startsWith('docker stack deploy')) callOrder.push('docker-stack-deploy');
      return originalExec(cmd);
    };
    const backend = makeBackend(conn, orderingVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    const verifyIdx = callOrder.indexOf('verifyBackup');
    const deployIdx = callOrder.indexOf('docker-stack-deploy');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(deployIdx);
  });
});

// ---------------------------------------------------------------------------
// Stateful deploy — volume preservation
// ---------------------------------------------------------------------------

describe('Stateful deploy — volume preservation', () => {
  it('does NOT issue docker volume rm for named volumes on stateful redeploy', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByVolume));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByVolume });

    const volumeRmCalled = conn.recordedCalls.some(
      (c) => c.op === 'exec' && (c.args[0] as string).includes('volume rm'),
    );
    expect(volumeRmCalled).toBe(false);
  });

  it('does NOT issue docker volume rm when role=database (role-based stateful)', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    const volumeRmCalled = conn.recordedCalls.some(
      (c) => c.op === 'exec' && (c.args[0] as string).includes('volume rm'),
    );
    expect(volumeRmCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stateful deploy — missing / stale backup blocks the deploy
// ---------------------------------------------------------------------------

describe('Stateful deploy — missing backup is blocked', () => {
  it('throws BackupRequiredError when no backup exists for role=database', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByRole }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('throws BackupRequiredError when backup is stale for role=database', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, staleBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByRole }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('does NOT issue any docker command when backup is missing', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    conn.recordedCalls.length = 0; // reset after build
    try {
      await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });
    } catch {
      // expected
    }
    const dockerCmds = conn.recordedCalls.filter(
      (c) => c.op === 'exec' && (c.args[0] as string).startsWith('docker'),
    );
    expect(dockerCmds).toHaveLength(0);
  });

  it('throws BackupRequiredError when no backup exists for named_volumes target', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByVolume));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByVolume }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });
});

// ---------------------------------------------------------------------------
// Stateless deploy — unaffected (no backup requirement)
// ---------------------------------------------------------------------------

describe('Stateless deploy — unchanged path', () => {
  it('proceeds without calling verifyBackup when target is stateless', async () => {
    let verifyBackupCalled = false;
    const trackingVerifier: VerifyBackupFn = async (input) => {
      verifyBackupCalled = true;
      return freshBackupVerifier(input);
    };
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, trackingVerifier);

    const artifact = await backend.build(mkCtx(statelessParams));
    const record = await backend.deploy(artifact, 'prod', { ...statelessParams });

    expect(verifyBackupCalled).toBe(false);
    expect(record.payload.stateful).toBe(false);
  });

  it('stateless record has stateful=false', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn);
    const artifact = await backend.build(mkCtx(statelessParams));
    const record = await backend.deploy(artifact, 'prod', { ...statelessParams });
    expect(record.payload.stateful).toBe(false);
  });

  it('stateless deploy still issues docker stack deploy normally', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, missingBackupVerifier /* would fail if called */);
    const artifact = await backend.build(mkCtx(statelessParams));
    const record = await backend.deploy(artifact, 'prod', { ...statelessParams });
    const deployed = conn.recordedCalls.some(
      (c) => c.op === 'exec' && (c.args[0] as string).startsWith('docker stack deploy'),
    );
    expect(deployed).toBe(true);
    expect(record.payload.stateful).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin bypass — requireBackup=false skips the backup gate
// ---------------------------------------------------------------------------

describe('Admin bypass — requireBackup=false', () => {
  it('allows stateful deploy without backup when requireBackup=false', async () => {
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, missingBackupVerifier, { requireBackup: false });

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    // Deploy succeeded despite no backup.
    expect(record.payload.stateful).toBe(true);
    const deployed = conn.recordedCalls.some(
      (c) => c.op === 'exec' && (c.args[0] as string).startsWith('docker stack deploy'),
    );
    expect(deployed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default backup_platform
// ---------------------------------------------------------------------------

describe('backup_platform default', () => {
  it('defaults backup_platform to "docker" when not specified', async () => {
    const calls: Array<{ platform: string }> = [];
    const capturingVerifier: VerifyBackupFn = async (input) => {
      calls.push({ platform: input.platform });
      return freshBackupVerifier(input);
    };
    const paramsNoBackupPlatform: DeployParameters = {
      ...baseParams,
      named_volumes: ['app-data'],
      // no backup_platform
    };
    const conn = mockDockerSwarmConnection(happyExecMap());
    const backend = makeBackend(conn, capturingVerifier);

    const artifact = await backend.build(mkCtx(paramsNoBackupPlatform));
    await backend.deploy(artifact, 'prod', { ...paramsNoBackupPlatform });

    expect(calls[0]?.platform).toBe('docker');
  });
});
