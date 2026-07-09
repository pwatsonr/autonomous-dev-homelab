/**
 * Stateful-aware UnraidHomelabBackend tests (issue #33).
 *
 * Verifies:
 *   1. Stateful target (role=database / storage_mounts) with a fresh verified
 *      backup → deploy proceeds, stateful=true in the record.
 *   2. Stateful target with no backup → deploy BLOCKED (BackupRequiredError
 *      propagates before any emhttp operation is issued).
 *   3. Stateful target with a stale backup → deploy BLOCKED.
 *   4. Storage mounts (host_path data) are NOT destroyed during a stateful
 *      redeploy — no removeContainer or destructive rm called before the
 *      backup gate passes.
 *   5. Stateless deploy (no role, no mounts) → deploy proceeds without
 *      calling verifyBackup at all.
 *   6. Backup gate is skipped when requireBackup=false (admin bypass path).
 *   7. record.payload.stateful flag is set correctly (true / false).
 *
 * All tests use in-memory MockUnraidEmhttpClient — no network or real filesystem.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureHmacSecret } from '../../helpers/hmac-secret';
import {
  asEmhttpClient,
  MockUnraidEmhttpClient,
} from '../../helpers/mock-emhttp';

import {
  UnraidHomelabBackend,
} from '../../../src/deploy/backends/unraid';
import { BackupRequiredError } from '../../../src/safety/errors';
import type { DeployParameters, BuildContext } from '../../../src/deploy/types';
import type { VerifyBackupFn } from '../../../src/deploy/backends/unraid';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseParams: DeployParameters = {
  host_id: 'unraid-01',
  container_name: 'myapp',
  image_uri: 'myrepo/myapp:3.0.0',
  network_mode: 'bridge',
  port_mappings: [],
  storage_mounts: [],
  env: {},
};

const statefulParamsByRole: DeployParameters = {
  ...baseParams,
  role: 'database',
  backup_platform: 'postgres',
};

const statefulParamsByMount: DeployParameters = {
  ...baseParams,
  storage_mounts: [
    { host_path: '/mnt/user/appdata/myapp', container_path: '/data' },
  ],
  backup_platform: 'unraid',
};

const statelessParams: DeployParameters = {
  ...baseParams,
  // no role, no storage_mounts → stateless
};

function mkCtx(params: DeployParameters = statelessParams): BuildContext {
  return {
    requestId: 'req-sf-unraid',
    envName: 'prod',
    repoPath: '/repo',
    commitSha: 'cafebabe01',
    params: { ...params },
  };
}

/** Returns a MockUnraidEmhttpClient pre-configured for a happy stateful deploy. */
function makeHappyClient(): MockUnraidEmhttpClient {
  return new MockUnraidEmhttpClient({
    pullStatus: {
      image: 'myrepo/myapp:3.0.0',
      digest: 'sha256:abc123',
      sizeBytes: 2048,
      status: 'complete',
    },
    inspectByName: new Map([
      ['myapp', { name: 'myapp', state: { running: true } }],
    ]),
    shares: ['/mnt/user/appdata', '/mnt/user/data'],
  });
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
  client: MockUnraidEmhttpClient,
  verifyBackup: VerifyBackupFn = freshBackupVerifier,
  opts: { requireBackup?: boolean } = {},
): UnraidHomelabBackend {
  let counter = 0;
  return new UnraidHomelabBackend({
    getClient: async () => asEmhttpClient(client),
    sleep: async () => undefined,
    now: () => 1700000000000,
    generateId: () => `unraid-sf-${++counter}`,
    verifyBackup,
    ...(opts.requireBackup !== undefined
      ? { statefulConfig: { requireBackup: opts.requireBackup } }
      : {}),
  });
}

let tempDataDir: string;

beforeAll(() => {
  ensureHmacSecret();
});

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unraid-sf-'));
  process.env['HOMELAB_DATA_DIR'] = tempDataDir;
});

afterEach(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  delete process.env['HOMELAB_DATA_DIR'];
});

// ---------------------------------------------------------------------------
// Stateful deploy — happy path (fresh backup)
// ---------------------------------------------------------------------------

describe('Stateful deploy — fresh backup', () => {
  it('proceeds when role=database and a fresh backup exists', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    expect(record.payload.stateful).toBe(true);
    expect(record.payload.details['backup_platform']).toBe('postgres');
    // addContainer was called (deploy happened).
    expect(client.recordedCalls.some((c) => c.op === 'addContainer')).toBe(true);
  });

  it('proceeds when storage_mounts non-empty and a fresh backup exists', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByMount));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByMount });

    expect(record.payload.stateful).toBe(true);
    expect(client.recordedCalls.some((c) => c.op === 'addContainer')).toBe(true);
  });

  it('calls verifyBackup with correct platform and target', async () => {
    const calls: Array<{ platform: string; target: string }> = [];
    const capturingVerifier: VerifyBackupFn = async (input) => {
      calls.push({ platform: input.platform, target: input.target });
      return freshBackupVerifier(input);
    };
    const client = makeHappyClient();
    const backend = makeBackend(client, capturingVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.platform).toBe('postgres');
    expect(calls[0]?.target).toBe('myapp');
  });

  it('calls verifyBackup BEFORE stopContainer / addContainer', async () => {
    const callOrder: string[] = [];
    const orderingVerifier: VerifyBackupFn = async (input) => {
      callOrder.push('verifyBackup');
      return freshBackupVerifier(input);
    };
    const client = makeHappyClient();
    const originalStop = client.stopContainer.bind(client);
    client.stopContainer = async (name: string) => {
      callOrder.push('stopContainer');
      return originalStop(name);
    };
    const originalAdd = client.addContainer.bind(client);
    client.addContainer = async (payload) => {
      callOrder.push('addContainer');
      return originalAdd(payload);
    };

    const backend = makeBackend(client, orderingVerifier);
    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    const verifyIdx = callOrder.indexOf('verifyBackup');
    const stopIdx = callOrder.indexOf('stopContainer');
    const addIdx = callOrder.indexOf('addContainer');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(verifyIdx);
    expect(addIdx).toBeGreaterThan(verifyIdx);
  });
});

// ---------------------------------------------------------------------------
// Stateful deploy — storage mount preservation
// ---------------------------------------------------------------------------

describe('Stateful deploy — storage mount preservation', () => {
  it('does NOT call removeContainer before the new container is started (mounts preserved)', async () => {
    // On a stateful redeploy, the host_path data must not be touched.
    // The backend stops the old container, adds the new one, starts it —
    // but never calls removeContainer before the add (that would be
    // data-destructive and requires an explicit operator action).
    const client = makeHappyClient();
    const backend = makeBackend(client, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByMount));
    client.recordedCalls.length = 0; // reset after build
    await backend.deploy(artifact, 'prod', { ...statefulParamsByMount });

    const ops = client.recordedCalls.map((c) => c.op);
    const removeIdx = ops.indexOf('removeContainer');
    const addIdx = ops.indexOf('addContainer');

    // removeContainer must NOT happen before addContainer on the normal path.
    // (It may happen in rollback, but that's a separate path tested in unraid.test.ts.)
    if (removeIdx !== -1 && addIdx !== -1) {
      // If removeContainer IS present, it must come AFTER add (rollback scenario).
      // In the happy path, removeContainer should not be called at all.
      expect(removeIdx).toBeGreaterThan(addIdx);
    }
    // The happy path: removeContainer is absent.
    expect(removeIdx).toBe(-1);
  });

  it('still passes the storage_mounts to addContainer unchanged', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, freshBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByMount));
    await backend.deploy(artifact, 'prod', { ...statefulParamsByMount });

    const addCall = client.recordedCalls.find((c) => c.op === 'addContainer');
    expect(addCall).toBeDefined();
    const addPayload = addCall?.args[0] as Record<string, unknown> | undefined;
    expect(Array.isArray(addPayload?.['volumes'])).toBe(true);
    // Verify the mount's container_path is present in the payload.
    const volumes = addPayload?.['volumes'] as Array<{ container_path?: string }> | undefined;
    const hasMount = volumes?.some((v) => v.container_path === '/data');
    expect(hasMount).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stateful deploy — missing / stale backup blocks the deploy
// ---------------------------------------------------------------------------

describe('Stateful deploy — missing backup is blocked', () => {
  it('throws BackupRequiredError when no backup exists for role=database', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByRole }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('throws BackupRequiredError when backup is stale for role=database', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, staleBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByRole }),
    ).rejects.toBeInstanceOf(BackupRequiredError);
  });

  it('does NOT call stopContainer or addContainer when backup is missing', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    client.recordedCalls.length = 0; // reset after build
    try {
      await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });
    } catch {
      // expected
    }
    const destructiveCalls = client.recordedCalls.filter((c) =>
      ['stopContainer', 'addContainer', 'removeContainer'].includes(c.op),
    );
    expect(destructiveCalls).toHaveLength(0);
  });

  it('throws BackupRequiredError when no backup exists for storage_mounts target', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statefulParamsByMount));
    await expect(
      backend.deploy(artifact, 'prod', { ...statefulParamsByMount }),
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
    const client = new MockUnraidEmhttpClient({
      pullStatus: {
        image: 'myrepo/myapp:3.0.0',
        digest: 'sha256:abc123',
        sizeBytes: 2048,
        status: 'complete',
      },
      inspectByName: new Map([
        ['myapp', { name: 'myapp', state: { running: true } }],
      ]),
    });
    const backend = makeBackend(client, trackingVerifier);

    const artifact = await backend.build(mkCtx(statelessParams));
    const record = await backend.deploy(artifact, 'prod', { ...statelessParams });

    expect(verifyBackupCalled).toBe(false);
    expect(record.payload.stateful).toBe(false);
    // Deploy still completed normally.
    expect(client.recordedCalls.some((c) => c.op === 'addContainer')).toBe(true);
  });

  it('stateless deploy with missing verifyBackup still succeeds', async () => {
    const client = new MockUnraidEmhttpClient({
      pullStatus: {
        image: 'myrepo/myapp:3.0.0',
        digest: 'sha256:abc123',
        sizeBytes: 2048,
        status: 'complete',
      },
      inspectByName: new Map([
        ['myapp', { name: 'myapp', state: { running: true } }],
      ]),
    });
    // missingBackupVerifier would throw if called — but it should NOT be
    // called on the stateless path.
    const backend = makeBackend(client, missingBackupVerifier);

    const artifact = await backend.build(mkCtx(statelessParams));
    const record = await backend.deploy(artifact, 'prod', { ...statelessParams });
    expect(record.payload.stateful).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin bypass — requireBackup=false skips the backup gate
// ---------------------------------------------------------------------------

describe('Admin bypass — requireBackup=false', () => {
  it('allows stateful deploy without backup when requireBackup=false', async () => {
    const client = makeHappyClient();
    const backend = makeBackend(client, missingBackupVerifier, { requireBackup: false });

    const artifact = await backend.build(mkCtx(statefulParamsByRole));
    const record = await backend.deploy(artifact, 'prod', { ...statefulParamsByRole });

    // Deploy succeeded despite no backup.
    expect(record.payload.stateful).toBe(true);
    expect(client.recordedCalls.some((c) => c.op === 'addContainer')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default backup_platform
// ---------------------------------------------------------------------------

describe('backup_platform default', () => {
  it('defaults backup_platform to "unraid" when not specified', async () => {
    const calls: Array<{ platform: string }> = [];
    const capturingVerifier: VerifyBackupFn = async (input) => {
      calls.push({ platform: input.platform });
      return freshBackupVerifier(input);
    };
    // Stateful by mount but no explicit backup_platform.
    const paramsNoBackupPlatform: DeployParameters = {
      ...baseParams,
      storage_mounts: [{ host_path: '/mnt/user/appdata/myapp', container_path: '/data' }],
      // no backup_platform
    };
    const client = makeHappyClient();
    const backend = makeBackend(client, capturingVerifier);

    const artifact = await backend.build(mkCtx(paramsNoBackupPlatform));
    await backend.deploy(artifact, 'prod', { ...paramsNoBackupPlatform });

    expect(calls[0]?.platform).toBe('unraid');
  });
});
