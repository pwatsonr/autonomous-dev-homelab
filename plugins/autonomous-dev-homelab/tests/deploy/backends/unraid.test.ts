/**
 * `UnraidHomelabBackend` unit tests per SPEC-002-3-04.
 *
 * Drives the backend through the in-memory `MockUnraidEmhttpClient`
 * (`tests/helpers/mock-emhttp`) so no HTTP calls escape the test process.
 * Records every emhttp invocation for call-order assertions
 * (`stop` BEFORE `add` when a container exists).
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
  PARAM_SCHEMA,
  UnraidHomelabBackend,
} from '../../../src/deploy/backends/unraid';
import { DeployError } from '../../../src/deploy/errors';
import { verifyDeploymentRecord } from '../../../src/deploy/sign-record';
import { validateParameters } from '../../../src/deploy/validate-parameters';
import type {
  BuildContext,
  DeployParameters,
  DeploymentRecord,
} from '../../../src/deploy/types';
import type { ContainerInspect } from '../../../src/deploy/backends/unraid-emhttp-client';

const baseParams: DeployParameters = {
  host_id: 'unraid-01',
  container_name: 'test-app',
  image_uri: 'nginx:latest',
  network_mode: 'bridge',
  port_mappings: ['8080:80'],
  storage_mounts: [],
  env: {},
};

function mkCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    requestId: 'req-1',
    envName: 'prod',
    repoPath: '/repo',
    commitSha: 'abc123',
    params: { ...baseParams },
    ...overrides,
  };
}

interface MakeOpts {
  pullStatus?: 'complete' | 'failed' | 'in-progress';
  inspect?: ContainerInspect | null;
  /** Returned by getShares; used to validate storage_mounts. */
  shares?: string[];
  /** Allow overriding the inspect queue used for poll loops. */
  inspectQueue?: Array<ContainerInspect | null>;
}

function makeBackendAndClient(
  opts: MakeOpts = {},
): { backend: UnraidHomelabBackend; client: MockUnraidEmhttpClient } {
  const status = opts.pullStatus ?? 'complete';
  const client = new MockUnraidEmhttpClient({
    pullStatus: {
      image: 'nginx:latest',
      digest: 'sha256:deadbeef',
      sizeBytes: 1024,
      status,
    },
    // Default: container exists in a "running" state so pollForRunning
    // exits on the first call. Tests that need an "existing-with-config"
    // case override via opts.inspect.
    inspectByName: new Map<string, ContainerInspect | null>([
      [
        'test-app',
        opts.inspect ?? { name: 'test-app', state: { running: true } },
      ],
    ]),
    ...(opts.shares !== undefined ? { shares: opts.shares } : {}),
  });
  if (opts.inspectQueue !== undefined) {
    client.setInspectQueue(opts.inspectQueue);
  }
  let counter = 0;
  const backend = new UnraidHomelabBackend({
    getClient: async () => asEmhttpClient(client),
    sleep: async () => undefined,
    now: () => 1700000000000,
    generateId: () => `unraid-test-${++counter}`,
  });
  return { backend, client };
}

let tempDataDir: string;

beforeAll(() => {
  ensureHmacSecret();
});

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unraid-deploy-'));
  process.env['HOMELAB_DATA_DIR'] = tempDataDir;
});

afterEach(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  delete process.env['HOMELAB_DATA_DIR'];
});

describe('UnraidHomelabBackend', () => {
  describe('PARAM_SCHEMA', () => {
    it('accepts valid bridge-network params', () => {
      expect(() => validateParameters({ ...baseParams }, PARAM_SCHEMA)).not.toThrow();
    });

    it('accepts valid host-network params', () => {
      expect(() =>
        validateParameters({ ...baseParams, network_mode: 'host' }, PARAM_SCHEMA),
      ).not.toThrow();
    });

    it('rejects missing required (container_name)', () => {
      const { container_name: _c, ...rest } = baseParams;
      expect(() => validateParameters(rest, PARAM_SCHEMA)).toThrow(/container_name/);
    });

    it('rejects bad enum (network_mode)', () => {
      expect(() =>
        validateParameters({ ...baseParams, network_mode: 'macvlan' }, PARAM_SCHEMA),
      ).toThrow(/one of/);
    });

    it('rejects bad regex (port_mappings entry)', () => {
      expect(() =>
        validateParameters(
          { ...baseParams, port_mappings: ['not-a-port'] },
          PARAM_SCHEMA,
        ),
      ).toThrow(/regex/);
    });

    it('rejects non-absolute storage_mounts.host_path', () => {
      expect(() =>
        validateParameters(
          {
            ...baseParams,
            storage_mounts: [{ host_path: 'relative/path', container_path: '/data' }],
          },
          PARAM_SCHEMA,
        ),
      ).toThrow(/absolute path/);
    });
  });

  describe('build', () => {
    it('returns BuildArtifact with digest+location on happy path', async () => {
      const { backend } = makeBackendAndClient();
      const artifact = await backend.build(mkCtx());
      expect(artifact.type).toBe('docker-image');
      expect(artifact.location).toBe('docker://nginx:latest@sha256:deadbeef');
      expect(artifact.checksum).toBe('sha256:deadbeef');
      expect(artifact.metadata['previous_container_config']).toBeNull();
    });

    it('throws IMAGE_PULL_FAILED when pull status is failed', async () => {
      const { backend } = makeBackendAndClient({ pullStatus: 'failed' });
      await expect(backend.build(mkCtx())).rejects.toMatchObject({
        code: 'IMAGE_PULL_FAILED',
      });
    });

    it('captures previous container config when one already exists', async () => {
      const { backend } = makeBackendAndClient({
        inspect: {
          name: 'test-app',
          state: { running: true },
          config: { image: 'nginx:1.24', name: 'test-app' },
        },
      });
      const artifact = await backend.build(mkCtx());
      expect(artifact.metadata['previous_container_config']).toEqual({
        image: 'nginx:1.24',
        name: 'test-app',
      });
    });
  });

  describe('deploy', () => {
    async function buildAndDeploy(
      makeOpts: MakeOpts = {},
      params: DeployParameters = baseParams,
    ): Promise<{ record: DeploymentRecord; client: MockUnraidEmhttpClient }> {
      const { backend, client } = makeBackendAndClient(makeOpts);
      const artifact = await backend.build(mkCtx({ params: { ...params } }));
      const record = await backend.deploy(artifact, 'prod', { ...params });
      return { record, client };
    }

    it('returns a signed DeploymentRecord (verifies HMAC)', async () => {
      const { record } = await buildAndDeploy();
      expect(record.hmac).not.toBe('');
      expect(verifyDeploymentRecord(record)).toBe(true);
    });

    it('issues stop BEFORE add when an existing container is present', async () => {
      const { client } = await buildAndDeploy({
        inspect: { name: 'test-app', state: { running: true } },
      });
      const ops = client.recordedCalls.map((c) => c.op);
      const stopIdx = ops.indexOf('stopContainer');
      const addIdx = ops.indexOf('addContainer');
      expect(stopIdx).toBeGreaterThan(-1);
      expect(addIdx).toBeGreaterThan(-1);
      expect(stopIdx).toBeLessThan(addIdx);
    });

    it('rejects storage_mounts.host_path that is outside any share', async () => {
      const { backend } = makeBackendAndClient({ shares: ['/mnt/user/data'] });
      const artifact = await backend.build(mkCtx());
      await expect(
        backend.deploy(artifact, 'prod', {
          ...baseParams,
          storage_mounts: [
            { host_path: '/etc/passwd', container_path: '/secrets' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('throws DEPLOY_FAILED when container never reaches running (sad path)', async () => {
      // Use an inspectByName map that returns running:false so pollForRunning
      // never satisfies, paired with a clock that jumps past the deadline on
      // the first sleep.
      const sickClient = new MockUnraidEmhttpClient({
        pullStatus: {
          image: 'nginx:latest',
          digest: 'sha256:deadbeef',
          sizeBytes: 1024,
          status: 'complete',
        },
        inspectByName: new Map([
          ['test-app', { name: 'test-app', state: { running: false } }],
        ]),
      });
      let nowVal = 1700000000000;
      const backend = new UnraidHomelabBackend({
        getClient: async () => asEmhttpClient(sickClient),
        sleep: async () => {
          nowVal += 65_000;
        },
        now: () => nowVal,
        generateId: () => 'unraid-sad',
      });
      const artifact = await backend.build(mkCtx());
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams }),
      ).rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
    });

    it('triggers rollback automatically when pollForRunning fails and previous config exists', async () => {
      // Build phase captures previous config. Deploy phase: new container fails
      // to reach running → rollback should restore the previous config.
      const previousConfig = { image: 'nginx:1.24', name: 'test-app' };
      // inspectQueue: first call in build (inspect existing) returns config,
      // second call in deploy (inspect existing before stop) returns running:true,
      // third call in deploy (pollForRunning) returns running:false → triggers rollback,
      // fourth call (rollback pollForRunning) returns running:true.
      const client = new MockUnraidEmhttpClient({
        pullStatus: {
          image: 'nginx:latest',
          digest: 'sha256:deadbeef',
          sizeBytes: 1024,
          status: 'complete',
        },
        inspectByName: new Map([
          ['test-app', { name: 'test-app', state: { running: true }, config: previousConfig }],
        ]),
      });
      let nowVal = 1700000000000;
      // Use a seeded queue so we can control the poll loop responses:
      // build's inspect → existing (has config)
      // deploy's existing inspect → running:true (so stop is called)
      // deploy's pollForRunning → running:false then deadline exceeded
      // rollback's pollForRunning → running:true
      client.setInspectQueue([
        { name: 'test-app', state: { running: true }, config: previousConfig }, // build: inspectContainer
        { name: 'test-app', state: { running: true } },                         // deploy: existing check
        { name: 'test-app', state: { running: false } },                        // deploy: pollForRunning #1 (then sleep → deadline)
        { name: 'test-app', state: { running: true } },                         // rollback: pollForRunning #1
      ]);
      const backend = new UnraidHomelabBackend({
        getClient: async () => asEmhttpClient(client),
        sleep: async () => {
          // Only advance time on the pollForRunning sleep (deploy phase).
          nowVal += 65_000;
        },
        now: () => nowVal,
        generateId: () => 'unraid-rollback-auto',
      });
      const artifact = await backend.build(mkCtx());
      // Confirm previous config was captured in artifact.
      expect(artifact.metadata['previous_container_config']).toEqual(previousConfig);
      client.recordedCalls.length = 0;
      let thrownError: unknown;
      try {
        await backend.deploy(artifact, 'prod', { ...baseParams });
      } catch (e) {
        thrownError = e;
      }
      expect(thrownError).toMatchObject({ code: 'DEPLOY_FAILED' });
      // Rollback should have been attempted (stopContainer called twice: once in
      // deploy to stop old, once in rollback; removeContainer + addContainer in rollback).
      const ops = client.recordedCalls.map((c) => c.op);
      expect(ops).toContain('removeContainer');
      const addCalls = client.recordedCalls.filter((c) => c.op === 'addContainer');
      // One addContainer for the new deploy, one for restoring previous config.
      expect(addCalls.length).toBeGreaterThanOrEqual(2);
      // Verify rollback_attempted is surfaced in the error.
      expect((thrownError as { details?: Record<string, unknown> }).details?.['rollback_attempted']).toBe(true);
    });

    it('does NOT trigger rollback on deploy failure when no previous config', async () => {
      // No existing container → previous_container_config is null → rollback must not run.
      const sickClient = new MockUnraidEmhttpClient({
        pullStatus: {
          image: 'nginx:latest',
          digest: 'sha256:deadbeef',
          sizeBytes: 1024,
          status: 'complete',
        },
        // null → no existing container → no previous config captured in build
        inspectByName: new Map([['test-app', null]]),
      });
      let nowVal = 1700000000000;
      // Override inspectQueue: build's inspect→null, deploy's existing→null,
      // pollForRunning returns running:false then deadline exceeded.
      sickClient.setInspectQueue([
        null,                                                            // build: inspectContainer → no existing
        null,                                                            // deploy: existing check → no container to stop
        { name: 'test-app', state: { running: false } },                // deploy: pollForRunning → not running
      ]);
      const backend = new UnraidHomelabBackend({
        getClient: async () => asEmhttpClient(sickClient),
        sleep: async () => { nowVal += 65_000; },
        now: () => nowVal,
        generateId: () => 'unraid-no-rollback',
      });
      const artifact = await backend.build(mkCtx());
      expect(artifact.metadata['previous_container_config']).toBeNull();
      sickClient.recordedCalls.length = 0;
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams }),
      ).rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
      const rollbackOps = sickClient.recordedCalls.filter((c) => c.op === 'removeContainer');
      expect(rollbackOps).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy: true when container reports state.health.status=healthy', async () => {
      const { backend } = makeBackendAndClient({
        inspect: {
          name: 'test-app',
          state: { running: true, health: { status: 'healthy' } },
        },
      });
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      const status = await backend.healthCheck(record);
      expect(status.healthy).toBe(true);
      expect(status.checks).toHaveLength(1);
    });

    it('returns healthy: false with reason when status=unhealthy', async () => {
      const { backend } = makeBackendAndClient();
      const artifact = await backend.build(mkCtx());
      const recordIsh = await backend.deploy(artifact, 'prod', { ...baseParams });
      // Build a separate client for healthCheck that returns unhealthy.
      const sickClient = new MockUnraidEmhttpClient({
        inspectByName: new Map([
          [
            'test-app',
            {
              name: 'test-app',
              state: { running: true, health: { status: 'unhealthy', failingStreak: 3 } },
            },
          ],
        ]),
      });
      const backend2 = new UnraidHomelabBackend({
        getClient: async () => asEmhttpClient(sickClient),
        sleep: async () => undefined,
        now: () => 1700000000000,
        generateId: () => 'h',
      });
      const status = await backend2.healthCheck(recordIsh);
      expect(status.healthy).toBe(false);
      expect(status.unhealthyReason).toContain('unhealthy');
    });
  });

  describe('rollback', () => {
    it('returns success: false with NO destructive emhttp calls when no previous config', async () => {
      const { backend, client } = makeBackendAndClient();
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      expect(record.payload.details['previous_container_config']).toBeNull();
      // Wipe call history; only rollback's calls should be recorded.
      client.recordedCalls.length = 0;
      const result = await backend.rollback(record);
      expect(result.success).toBe(false);
      const destructive = client.recordedCalls.filter((c) =>
        ['stopContainer', 'removeContainer', 'addContainer', 'startContainer'].includes(c.op),
      );
      expect(destructive).toHaveLength(0);
    });

    it('rolls back successfully when previous_container_config is populated', async () => {
      const { backend, client } = makeBackendAndClient({
        inspect: {
          name: 'test-app',
          state: { running: true },
          config: { image: 'nginx:1.24', name: 'test-app' },
        },
      });
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      client.recordedCalls.length = 0;
      const result = await backend.rollback(record);
      expect(result.success).toBe(true);
      expect(result.restoredArtifactId).toBe('docker://nginx:1.24');
    });

    it('restores the EXACT previous config to addContainer on rollback', async () => {
      // Verify the config passed to addContainer during rollback matches the
      // captured previous config, not the new deploy payload.
      const previousConfig = { image: 'nginx:1.24', name: 'test-app', network_mode: 'bridge' };
      const { backend, client } = makeBackendAndClient({
        inspect: {
          name: 'test-app',
          state: { running: true },
          config: previousConfig,
        },
      });
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      client.recordedCalls.length = 0;
      await backend.rollback(record);
      const addCall = client.recordedCalls.find((c) => c.op === 'addContainer');
      expect(addCall).toBeDefined();
      expect(addCall?.args[0]).toEqual(previousConfig);
    });

    it('rollback with no previous config is a safe no-op (no errors thrown, clear status)', async () => {
      // Scenario: first-ever deploy → no previous config. rollback() must return
      // a clean failure result, not throw or crash.
      const { backend } = makeBackendAndClient();
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      expect(record.payload.details['previous_container_config']).toBeNull();
      // Should resolve (not reject).
      const result = await backend.rollback(record);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/no previous/i);
    });
  });
});
