/**
 * `DockerSwarmHomelabBackend` unit tests per SPEC-002-3-04.
 *
 * Drives the backend via `mockDockerSwarmConnection` (no real shell, no
 * network). Verifies stack-deploy command construction, path-traversal
 * guards on `compose_file_path`, signed records, and rollback semantics
 * (no destructive call when previous spec is null).
 */

import { ensureHmacSecret } from '../../helpers/hmac-secret';
import {
  mockDockerSwarmConnection,
  type MockConnection,
} from '../../helpers/mock-connections';

import {
  DockerSwarmHomelabBackend,
  PARAM_SCHEMA,
} from '../../../src/deploy/backends/docker-swarm';
import { DeployError } from '../../../src/deploy/errors';
import { verifyDeploymentRecord } from '../../../src/deploy/sign-record';
import { validateParameters } from '../../../src/deploy/validate-parameters';
import type {
  BuildContext,
  DeployParameters,
  DeploymentRecord,
} from '../../../src/deploy/types';

const baseParams: DeployParameters = {
  manager_id: 'swarm-mgr',
  stack_name: 'web',
  compose_file_path: 'deploy/web.yml',
  image_uri: 'ghcr.io/owner/web:1.2.3',
  service_name: 'api',
};

function mkCtx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    requestId: 'req-1',
    envName: 'prod',
    repoPath: '/repo',
    commitSha: 'abc123def',
    params: { ...baseParams },
    ...overrides,
  };
}

function happyExecMap(opts: { hasPrevious?: boolean } = {}): Parameters<typeof mockDockerSwarmConnection>[0] {
  const inspectStdout = opts.hasPrevious === true
    ? JSON.stringify([
        {
          Spec: { Mode: { Replicated: { Replicas: 1 } } },
          Endpoint: { Spec: { Ports: [{ TargetPort: 80, PublishedPort: 8080 }] } },
        },
      ])
    : '';
  return {
    patterns: [
      {
        match: 'docker service inspect',
        result: {
          stdout: inspectStdout,
          stderr: opts.hasPrevious === true ? '' : 'no such service',
          exitCode: opts.hasPrevious === true ? 0 : 1,
        },
      },
      {
        match: 'docker stack deploy',
        result: { stdout: 'Updating service web_api', stderr: '', exitCode: 0 },
      },
      {
        match: 'docker service ps',
        result: {
          stdout: JSON.stringify({ CurrentState: 'Running 5 minutes ago' }) + '\n',
          stderr: '',
          exitCode: 0,
        },
      },
      {
        match: 'docker service rollback',
        result: { stdout: '', stderr: '', exitCode: 0 },
      },
    ],
    fallback: { stdout: '', stderr: '', exitCode: 0 },
  };
}

function makeBackend(conn: MockConnection): DockerSwarmHomelabBackend {
  let counter = 0;
  return new DockerSwarmHomelabBackend({
    getConnection: async () => conn,
    sleep: async () => undefined,
    now: () => 1700000000000,
    generateId: () => `swarm-test-${++counter}`,
  });
}

beforeAll(() => {
  ensureHmacSecret();
});

describe('DockerSwarmHomelabBackend', () => {
  describe('PARAM_SCHEMA', () => {
    it('accepts valid params', () => {
      expect(() => validateParameters({ ...baseParams }, PARAM_SCHEMA)).not.toThrow();
    });

    it('accepts numeric health_timeout in range', () => {
      expect(() =>
        validateParameters({ ...baseParams, health_timeout_seconds: 60 }, PARAM_SCHEMA),
      ).not.toThrow();
    });

    it('rejects missing required (manager_id)', () => {
      const { manager_id: _m, ...rest } = baseParams;
      expect(() => validateParameters(rest, PARAM_SCHEMA)).toThrow(/manager_id/);
    });

    it('rejects bad regex (stack_name with uppercase)', () => {
      expect(() =>
        validateParameters({ ...baseParams, stack_name: 'BadName' }, PARAM_SCHEMA),
      ).toThrow(/regex/);
    });

    it('rejects out-of-range health_timeout (> 600)', () => {
      expect(() =>
        validateParameters({ ...baseParams, health_timeout_seconds: 9999 }, PARAM_SCHEMA),
      ).toThrow(/in \[10/);
    });

    it('rejects shell-unsafe image_uri', () => {
      expect(() =>
        validateParameters({ ...baseParams, image_uri: 'evil; rm -rf /' }, PARAM_SCHEMA),
      ).toThrow(/shell-unsafe/);
    });
  });

  describe('build', () => {
    it('returns BuildArtifact with commit SHA as location', async () => {
      const conn = mockDockerSwarmConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      expect(artifact.type).toBe('commit');
      expect(artifact.location).toBe('abc123def');
      expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.metadata['stack_name']).toBe('web');
    });

    it('throws on invalid params (missing service_name)', async () => {
      const conn = mockDockerSwarmConnection(happyExecMap());
      const backend = makeBackend(conn);
      const { service_name: _s, ...rest } = baseParams;
      await expect(backend.build(mkCtx({ params: { ...rest } }))).rejects.toThrow(DeployError);
    });
  });

  describe('deploy', () => {
    it('returns a signed DeploymentRecord on happy path', async () => {
      const conn = mockDockerSwarmConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      expect(record.hmac).not.toBe('');
      expect(verifyDeploymentRecord(record)).toBe(true);
      expect(record.payload.details['stack_name']).toBe('web');
    });

    it('captures previous_service_spec BEFORE running stack deploy', async () => {
      const conn = mockDockerSwarmConnection(happyExecMap({ hasPrevious: true }));
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      conn.recordedCalls.length = 0;
      await backend.deploy(artifact, 'prod', { ...baseParams });
      const ops = conn.recordedCalls
        .filter((c) => c.op === 'exec')
        .map((c) => c.args[0] as string);
      const inspectIdx = ops.findIndex((c) => c.startsWith('docker service inspect'));
      const deployIdx = ops.findIndex((c) => c.startsWith('docker stack deploy'));
      expect(inspectIdx).toBeGreaterThan(-1);
      expect(deployIdx).toBeGreaterThan(inspectIdx);
    });

    it('rejects compose_file_path that escapes the repo (parameter rejection)', async () => {
      const conn = mockDockerSwarmConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      conn.recordedCalls.length = 0;
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams, compose_file_path: '../../etc/passwd' }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      // No deploy command was issued.
      expect(
        conn.recordedCalls.some(
          (c) => c.op === 'exec' && (c.args[0] as string).includes('docker stack deploy'),
        ),
      ).toBe(false);
    });

    it('throws DEPLOY_FAILED when docker stack deploy returns non-zero (sad path)', async () => {
      const conn = mockDockerSwarmConnection({
        patterns: [
          {
            match: 'docker service inspect',
            result: { stdout: '', stderr: 'no such service', exitCode: 1 },
          },
          {
            match: 'docker stack deploy',
            result: { stdout: '', stderr: 'image pull denied', exitCode: 2 },
          },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams }),
      ).rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
    });
  });

  describe('healthCheck', () => {
    it('returns healthy: true when running tasks == replica count', async () => {
      const conn = mockDockerSwarmConnection({
        patterns: [
          {
            match: 'docker service inspect',
            result: {
              stdout: JSON.stringify([{ Spec: { Mode: { Replicated: { Replicas: 1 } } } }]),
              stderr: '',
              exitCode: 0,
            },
          },
          {
            match: 'docker service ps',
            result: {
              stdout: JSON.stringify({ CurrentState: 'Running 5 minutes ago' }) + '\n',
              stderr: '',
              exitCode: 0,
            },
          },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      const status = await backend.healthCheck(record);
      expect(status.healthy).toBe(true);
    });

    it('returns healthy: false when a task is in Failed state', async () => {
      // Mutating connection: respond differently for healthCheck.
      let phase: 'happy' | 'sick' = 'happy';
      const conn = mockDockerSwarmConnection({
        patterns: [
          {
            match: 'docker service inspect',
            result: {
              stdout: JSON.stringify([{ Spec: { Mode: { Replicated: { Replicas: 1 } } } }]),
              stderr: '',
              exitCode: 0,
            },
          },
          {
            match: 'docker service ps',
            result: {
              stdout: JSON.stringify({ CurrentState: 'Running 5 minutes ago' }) + '\n',
              stderr: '',
              exitCode: 0,
            },
          },
          {
            match: 'docker stack deploy',
            result: { stdout: '', stderr: '', exitCode: 0 },
          },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      const originalExec = conn.exec.bind(conn);
      conn.exec = async (cmd: string) => {
        if (phase === 'sick' && cmd.startsWith('docker service ps')) {
          conn.recordedCalls.push({ op: 'exec', args: [cmd] });
          return {
            stdout: JSON.stringify({ CurrentState: 'Failed 1 minute ago', Error: 'oom' }) + '\n',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          };
        }
        return originalExec(cmd);
      };
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      phase = 'sick';
      const status = await backend.healthCheck(record);
      expect(status.healthy).toBe(false);
      expect(status.unhealthyReason).toBeDefined();
    });
  });

  describe('rollback', () => {
    it('returns success: false with no docker call when previous_service_spec is null', async () => {
      // Build a record manually with no previous spec.
      const conn = mockDockerSwarmConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      expect(record.payload.details['previous_service_spec']).toBeNull();
      conn.recordedCalls.length = 0;
      const result = await backend.rollback(record);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        conn.recordedCalls.some(
          (c) => c.op === 'exec' && (c.args[0] as string).startsWith('docker service rollback'),
        ),
      ).toBe(false);
    });

    it('rolls back successfully when previous_service_spec is populated and UpdateStatus is completed', async () => {
      const conn = mockDockerSwarmConnection({
        patterns: [
          {
            match: 'docker service inspect',
            result: {
              stdout: JSON.stringify([
                {
                  Spec: { Mode: { Replicated: { Replicas: 1 } } },
                  UpdateStatus: { State: 'completed' },
                },
              ]),
              stderr: '',
              exitCode: 0,
            },
          },
          {
            match: 'docker stack deploy',
            result: { stdout: '', stderr: '', exitCode: 0 },
          },
          {
            match: 'docker service rollback',
            result: { stdout: '', stderr: '', exitCode: 0 },
          },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      // Override the inspect to return the format used by rollback's poll
      // ({{.UpdateStatus.State}}). We hand-craft another pattern below.
      const originalExec = conn.exec.bind(conn);
      conn.exec = async (cmd: string) => {
        if (cmd.includes('--format')) {
          conn.recordedCalls.push({ op: 'exec', args: [cmd] });
          return { stdout: 'completed\n', stderr: '', exitCode: 0, durationMs: 1 };
        }
        return originalExec(cmd);
      };
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      // Verify previous spec was captured.
      expect(record.payload.details['previous_service_spec']).not.toBeNull();
      conn.recordedCalls.length = 0;
      const result = await backend.rollback(record);
      expect(result.success).toBe(true);
      expect(result.restoredArtifactId).toContain('swarm://');
    });
  });
});
