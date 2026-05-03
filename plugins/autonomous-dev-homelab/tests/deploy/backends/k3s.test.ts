/**
 * `K3sHomelabBackend` unit tests per SPEC-002-3-04.
 *
 * The backend wraps an autonomous-dev `K8sBackend` (mocked here as a
 * structural `K8sBackendLike`) plus a `K3sCredentialClient` (mocked).
 * Tests verify:
 *   - PARAM_SCHEMA validation
 *   - Credential acquisition happens BEFORE the wrapped k8s call
 *   - Token-lifetime guard rejects long-lived credentials
 *   - rollback requires details.cluster_id
 *   - NO `child_process` is invoked from any path
 */

import { ensureHmacSecret } from '../../helpers/hmac-secret';

import {
  K3sHomelabBackend,
  PARAM_SCHEMA,
  type K8sBackendLike,
} from '../../../src/deploy/backends/k3s';
import {
  createK3sCredentialClient,
  type K3sCredentialClient,
} from '../../../src/deploy/backends/k3s-credential-client';
import { DeployError } from '../../../src/deploy/errors';
import { signDeploymentRecord } from '../../../src/deploy/sign-record';
import { validateParameters } from '../../../src/deploy/validate-parameters';
import type {
  CredentialProxy,
  ScopedCredential,
} from '../../../src/deploy/credential-proxy-types';
import type {
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../../src/deploy/types';

const baseParams: DeployParameters = {
  cluster_id: 'home-k3s',
  namespace: 'web',
  manifest_path: 'k8s/web.yaml',
  deployment_name: 'web',
  ready_timeout_seconds: 60,
};

interface CredAcquisition {
  kind: string;
  op: string;
  resource: string;
}

function makeProxy(
  override: Partial<ScopedCredential> = {},
  recorded?: CredAcquisition[],
): CredentialProxy {
  return {
    async acquire(kind, op, scope) {
      recorded?.push({ kind, op, resource: scope.resource });
      return {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        tokenLifetimeSeconds: 600,
        ...override,
      };
    },
  };
}

interface MockBackendCalls {
  build: BuildContext[];
  deploy: Array<{ artifact: BuildArtifact; env: string; params: DeployParameters }>;
  health: DeploymentRecord[];
  rollback: DeploymentRecord[];
}

function makeWrappedK8s(): { k8s: K8sBackendLike; calls: MockBackendCalls } {
  const calls: MockBackendCalls = { build: [], deploy: [], health: [], rollback: [] };
  const k8s: K8sBackendLike = {
    async build(ctx: BuildContext): Promise<BuildArtifact> {
      calls.build.push(ctx);
      return {
        type: 'k8s-manifest',
        location: `k8s://${ctx.commitSha}`,
        checksum: 'cafe1234',
        sizeBytes: 0,
        metadata: { manifest_path: (ctx.params['manifest_path'] as string | undefined) ?? '' },
      };
    },
    async deploy(artifact, env, params): Promise<DeploymentRecord> {
      calls.deploy.push({ artifact, env, params });
      return signDeploymentRecord({
        id: 'k8s-1',
        backendName: 'k8s',
        target: 'k8s',
        envName: env,
        artifactLocation: artifact.location,
        details: { ns: params['namespace'] as string },
        deployedAt: '2024-01-01T00:00:00.000Z',
      });
    },
    async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
      calls.health.push(record);
      return {
        healthy: true,
        checks: [{ timestamp: '2024-01-01T00:00:00.000Z', outcome: 'success', latencyMs: 1 }],
      };
    },
    async rollback(record: DeploymentRecord): Promise<RollbackResult> {
      calls.rollback.push(record);
      return { success: true, restoredArtifactId: 'k8s://prev', errors: [] };
    },
  };
  return { k8s, calls };
}

function makeBackend(
  k8s: K8sBackendLike,
  credentialClient: K3sCredentialClient,
  resolveContextName: (clusterId: string) => Promise<string> = async (id) => `ctx-${id}`,
): K3sHomelabBackend {
  return new K3sHomelabBackend({
    k8sBackend: k8s,
    credentialClient,
    resolveContextName,
  });
}

beforeAll(() => {
  ensureHmacSecret();
});

describe('K3sHomelabBackend', () => {
  describe('PARAM_SCHEMA', () => {
    it('accepts valid params', () => {
      expect(() => validateParameters({ ...baseParams }, PARAM_SCHEMA)).not.toThrow();
    });

    it('accepts default namespace when omitted', () => {
      const { namespace: _ns, ...rest } = baseParams;
      const out = validateParameters(rest, PARAM_SCHEMA);
      expect(out['namespace']).toBe('default');
    });

    it('rejects missing required (cluster_id)', () => {
      const { cluster_id: _c, ...rest } = baseParams;
      expect(() => validateParameters(rest, PARAM_SCHEMA)).toThrow(/cluster_id/);
    });

    it('rejects out-of-range ready_timeout_seconds (< 10)', () => {
      expect(() =>
        validateParameters({ ...baseParams, ready_timeout_seconds: 5 }, PARAM_SCHEMA),
      ).toThrow(/in \[10/);
    });

    it('rejects bad-format namespace (uppercase)', () => {
      expect(() =>
        validateParameters({ ...baseParams, namespace: 'Bad Namespace!' }, PARAM_SCHEMA),
      ).toThrow(/identifier/);
    });
  });

  describe('build', () => {
    it('delegates to wrapped K8sBackend.build', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const credClient = createK3sCredentialClient(makeProxy());
      const backend = makeBackend(k8s, credClient);
      const artifact = await backend.build({
        requestId: 'r1',
        envName: 'prod',
        repoPath: '/repo',
        commitSha: 'abcdef',
        params: { ...baseParams },
      });
      expect(artifact.location).toBe('k8s://abcdef');
      expect(calls.build).toHaveLength(1);
    });
  });

  describe('deploy', () => {
    it('acquires credential BEFORE invoking the wrapped k8s deploy', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const recorded: CredAcquisition[] = [];
      const credClient = createK3sCredentialClient(makeProxy({}, recorded));
      const backend = makeBackend(k8s, credClient);
      const artifact = await backend.build({
        requestId: 'r1',
        envName: 'prod',
        repoPath: '/repo',
        commitSha: 'abc',
        params: { ...baseParams },
      });
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.op).toBe('K8s:Apply');
      expect(recorded[0]?.resource).toBe('cluster:ctx-home-k3s/namespace:web');
      // Credential acquired BEFORE wrapped deploy.
      expect(calls.deploy).toHaveLength(1);
      // The forwarded params include the scoped kubeconfig.
      expect(calls.deploy[0]?.params['scopedKubeconfig']).toBe(
        'apiVersion: v1\nkind: Config\n',
      );
      // The returned record's backendName is overridden to 'k3s'.
      expect(record.payload.backendName).toBe('k3s');
      expect(record.payload.details['cluster_id']).toBe('home-k3s');
    });

    it('rejects long-lived credential (> 900s)', async () => {
      const { k8s } = makeWrappedK8s();
      const proxy: CredentialProxy = {
        async acquire(_kind, _op, _scope) {
          return {
            kubeconfig: 'apiVersion: v1\nkind: Config\n',
            expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
            tokenLifetimeSeconds: 7200,
          };
        },
      };
      const credClient = createK3sCredentialClient(proxy);
      const backend = makeBackend(k8s, credClient);
      const artifact = await backend.build({
        requestId: 'r1',
        envName: 'prod',
        repoPath: '/repo',
        commitSha: 'abc',
        params: { ...baseParams },
      });
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams }),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    });

    it('rejects deploy when params are invalid', async () => {
      const { k8s } = makeWrappedK8s();
      const credClient = createK3sCredentialClient(makeProxy());
      const backend = makeBackend(k8s, credClient);
      const artifact: BuildArtifact = {
        type: 'k8s-manifest',
        location: 'k8s://abc',
        checksum: 'x',
        sizeBytes: 0,
        metadata: {},
      };
      const { cluster_id: _c, ...rest } = baseParams;
      await expect(backend.deploy(artifact, 'prod', { ...rest })).rejects.toThrow(DeployError);
    });
  });

  describe('healthCheck', () => {
    it('acquires K8s:Read credential before delegating', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const recorded: CredAcquisition[] = [];
      const credClient = createK3sCredentialClient(makeProxy({}, recorded));
      const backend = makeBackend(k8s, credClient);
      const record = signDeploymentRecord({
        id: 'r',
        backendName: 'k3s',
        target: 'homelab-k3s',
        envName: 'prod',
        artifactLocation: 'k8s://abc',
        details: { cluster_id: 'home-k3s', namespace: 'web' },
        deployedAt: '2024-01-01T00:00:00.000Z',
      });
      const status = await backend.healthCheck(record);
      expect(status.healthy).toBe(true);
      expect(recorded.find((r) => r.op === 'K8s:Read')).toBeDefined();
      expect(calls.health).toHaveLength(1);
    });
  });

  describe('rollback', () => {
    it('throws ROLLBACK_FAILED when details.cluster_id is missing', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const credClient = createK3sCredentialClient(makeProxy());
      const backend = makeBackend(k8s, credClient);
      const record = signDeploymentRecord({
        id: 'r',
        backendName: 'k3s',
        target: 'homelab-k3s',
        envName: 'prod',
        artifactLocation: 'k8s://abc',
        details: {},
        deployedAt: '2024-01-01T00:00:00.000Z',
      });
      await expect(backend.rollback(record)).rejects.toMatchObject({
        code: 'ROLLBACK_FAILED',
      });
      expect(calls.rollback).toHaveLength(0);
    });

    it('acquires K8s:Patch credential and delegates on happy path', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const recorded: CredAcquisition[] = [];
      const credClient = createK3sCredentialClient(makeProxy({}, recorded));
      const backend = makeBackend(k8s, credClient);
      const record = signDeploymentRecord({
        id: 'r',
        backendName: 'k3s',
        target: 'homelab-k3s',
        envName: 'prod',
        artifactLocation: 'k8s://abc',
        details: { cluster_id: 'home-k3s', namespace: 'web' },
        deployedAt: '2024-01-01T00:00:00.000Z',
      });
      const result = await backend.rollback(record);
      expect(result.success).toBe(true);
      expect(recorded.find((r) => r.op === 'K8s:Patch')).toBeDefined();
      expect(calls.rollback).toHaveLength(1);
    });
  });

  describe('no-shell guarantee', () => {
    // The K3s homelab backend NEVER imports `node:child_process` directly —
    // it forwards through the injected `K8sBackendLike`. We assert the
    // behavioral contract: when the wrapped k8s backend is a pure-JS stub,
    // the four interface methods complete without ANY shell invocation by
    // confirming the stub records every call and no other code path runs.
    it('relies entirely on the injected K8sBackendLike (no other side-effects)', async () => {
      const { k8s, calls } = makeWrappedK8s();
      const credClient = createK3sCredentialClient(makeProxy());
      const backend = makeBackend(k8s, credClient);
      const ctx: BuildContext = {
        requestId: 'r1',
        envName: 'prod',
        repoPath: '/repo',
        commitSha: 'abc',
        params: { ...baseParams },
      };
      const artifact = await backend.build(ctx);
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      await backend.healthCheck(record);
      await backend.rollback(record);
      // Every interface call landed on the stub exactly once.
      expect(calls.build).toHaveLength(1);
      expect(calls.deploy).toHaveLength(1);
      expect(calls.health).toHaveLength(1);
      expect(calls.rollback).toHaveLength(1);
      // The source module does not import child_process at all.
      const src = require('node:fs').readFileSync(
        require('node:path').resolve(__dirname, '../../../src/deploy/backends/k3s.ts'),
        'utf8',
      ) as string;
      expect(src).not.toMatch(/['"]child_process['"]/);
      expect(src).not.toMatch(/['"]node:child_process['"]/);
    });
  });
});
