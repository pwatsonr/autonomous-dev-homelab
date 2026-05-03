/**
 * `ProxmoxHomelabBackend` unit tests per SPEC-002-3-04.
 *
 * Covers the `DeploymentBackend` contract methods (`build` / `deploy` /
 * `healthCheck` / `rollback`) for happy + sad paths plus PARAM_SCHEMA
 * validation. Every dependency is mocked through `mockProxmoxConnection`;
 * NO real `child_process` invocation, NO network. The HMAC secret is set
 * via `ensureHmacSecret` so signed records can be produced + verified.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureHmacSecret } from '../../helpers/hmac-secret';
import {
  mockProxmoxConnection,
  type MockConnection,
} from '../../helpers/mock-connections';

import {
  PARAM_SCHEMA,
  ProxmoxHomelabBackend,
} from '../../../src/deploy/backends/proxmox';
import { DeployError } from '../../../src/deploy/errors';
import { verifyDeploymentRecord } from '../../../src/deploy/sign-record';
import { validateParameters } from '../../../src/deploy/validate-parameters';
import type {
  BuildContext,
  DeployParameters,
  DeploymentRecord,
} from '../../../src/deploy/types';

const baseParams: DeployParameters = {
  node_id: 'pve-01',
  workload_kind: 'lxc',
  vmid: 100,
  image_uri: 'local:vztmpl/debian-12.tar.zst',
  storage_pool: 'local-lvm',
  hostname: 'web1',
  cores: 2,
  memory_mb: 1024,
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

function happyExecMap(): Parameters<typeof mockProxmoxConnection>[0] {
  return {
    patterns: [
      { match: 'pct create', result: { stdout: 'extracted volume', stderr: '', exitCode: 0 } },
      { match: 'pct start', result: { stdout: '', stderr: '', exitCode: 0 } },
      { match: 'pct status', result: { stdout: 'status: running', stderr: '', exitCode: 0 } },
      { match: 'pct exec', result: { stdout: '[]', stderr: '', exitCode: 0 } },
      { match: 'pct stop', result: { stdout: '', stderr: '', exitCode: 0 } },
      { match: 'qm create', result: { stdout: '', stderr: '', exitCode: 0 } },
      { match: 'qm importdisk', result: { stdout: '', stderr: '', exitCode: 0 } },
      { match: 'qm start', result: { stdout: '', stderr: '', exitCode: 0 } },
      { match: 'qm status', result: { stdout: 'status: running', stderr: '', exitCode: 0 } },
      { match: 'qm guest cmd', result: { stdout: '[]', stderr: '', exitCode: 0 } },
      { match: 'qm stop', result: { stdout: '', stderr: '', exitCode: 0 } },
    ],
    fallback: { stdout: '', stderr: '', exitCode: 0 },
  };
}

function makeBackend(conn: MockConnection): ProxmoxHomelabBackend {
  let counter = 0;
  return new ProxmoxHomelabBackend({
    getConnection: async () => conn,
    sleep: async () => undefined,
    now: () => 1700000000000,
    generateId: () => `prox-test-${++counter}`,
  });
}

let tempDataDir: string;

beforeAll(() => {
  ensureHmacSecret();
});

beforeEach(async () => {
  tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prox-deploy-'));
  process.env['HOMELAB_DATA_DIR'] = tempDataDir;
});

afterEach(async () => {
  await fs.rm(tempDataDir, { recursive: true, force: true });
  delete process.env['HOMELAB_DATA_DIR'];
});

describe('ProxmoxHomelabBackend', () => {
  describe('PARAM_SCHEMA', () => {
    it('accepts valid LXC params (happy)', () => {
      expect(() => validateParameters({ ...baseParams }, PARAM_SCHEMA)).not.toThrow();
    });

    it('accepts valid VM params (happy)', () => {
      const params = { ...baseParams, workload_kind: 'vm', vmid: 200 };
      expect(() => validateParameters(params, PARAM_SCHEMA)).not.toThrow();
    });

    it('rejects missing required (vmid)', () => {
      const { vmid: _vmid, ...rest } = baseParams;
      expect(() => validateParameters(rest, PARAM_SCHEMA)).toThrow(DeployError);
    });

    it('rejects wrong type (vmid as boolean)', () => {
      expect(() =>
        validateParameters({ ...baseParams, vmid: true }, PARAM_SCHEMA),
      ).toThrow(/finite number/);
    });

    it('rejects out-of-range vmid (< 100)', () => {
      expect(() =>
        validateParameters({ ...baseParams, vmid: 50 }, PARAM_SCHEMA),
      ).toThrow(/in \[100/);
    });

    it('rejects bad enum (workload_kind)', () => {
      expect(() =>
        validateParameters({ ...baseParams, workload_kind: 'docker' }, PARAM_SCHEMA),
      ).toThrow(/one of/);
    });

    it('rejects bad regex (ip_cidr)', () => {
      expect(() =>
        validateParameters({ ...baseParams, ip_cidr: 'not-a-cidr' }, PARAM_SCHEMA),
      ).toThrow(/regex/);
    });
  });

  describe('build', () => {
    it('returns BuildArtifact with expected shape on happy path (LXC)', async () => {
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      expect(artifact.type).toBe('proxmox-instance');
      expect(artifact.location).toBe('proxmox://pve-01/lxc/100');
      expect(artifact.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.metadata['node_id']).toBe('pve-01');
      expect(artifact.metadata['vmid']).toBe(100);
      expect(artifact.metadata['previous_vmid']).toBeNull();
    });

    it('throws DeployError when pct create returns non-zero', async () => {
      const conn = mockProxmoxConnection({
        patterns: [
          {
            match: 'pct create',
            result: { stdout: '', stderr: 'storage missing', exitCode: 1 },
          },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      const backend = makeBackend(conn);
      await expect(backend.build(mkCtx())).rejects.toMatchObject({
        code: 'BUILD_FAILED',
      });
    });

    it('rejects vmid in reserved range during build (< 100)', async () => {
      // PARAM_SCHEMA range guard catches vmid<100 first.
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const ctx = mkCtx({ params: { ...baseParams, vmid: 50 } });
      await expect(backend.build(ctx)).rejects.toThrow(DeployError);
    });
  });

  describe('deploy', () => {
    async function buildAndDeploy(
      conn: MockConnection,
      params: DeployParameters = baseParams,
    ): Promise<DeploymentRecord> {
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx({ params: { ...params } }));
      // Reset recorded calls so the deploy assertions only see deploy ops.
      conn.recordedCalls.length = 0;
      return backend.deploy(artifact, 'prod', { ...params });
    }

    it('returns a signed DeploymentRecord and call order is start → status → exec', async () => {
      const conn = mockProxmoxConnection(happyExecMap());
      const record = await buildAndDeploy(conn);
      expect(record.hmac).not.toBe('');
      expect(verifyDeploymentRecord(record)).toBe(true);
      const execOps = conn.recordedCalls.filter((c) => c.op === 'exec');
      expect((execOps[0]?.args[0] as string)).toMatch(/^pct start /);
    });

    it('rejects shell-unsafe image_uri (parameter rejection)', async () => {
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      conn.recordedCalls.length = 0;
      await expect(
        backend.deploy(artifact, 'prod', { ...baseParams, image_uri: 'evil; rm -rf /' }),
      ).rejects.toThrow(/shell-unsafe/);
      // No destructive call was issued.
      expect(conn.recordedCalls.filter((c) => c.op === 'exec')).toHaveLength(0);
    });

    it('throws DeployError when pct start returns non-zero (sad path)', async () => {
      const conn = mockProxmoxConnection({
        patterns: [
          { match: 'pct create', result: { stdout: 'ok', stderr: '', exitCode: 0 } },
          { match: 'pct start', result: { stdout: '', stderr: 'boot failed', exitCode: 2 } },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      conn.recordedCalls.length = 0;
      await expect(backend.deploy(artifact, 'prod', { ...baseParams })).rejects.toMatchObject({
        code: 'DEPLOY_FAILED',
        message: expect.stringContaining('boot failed'),
      });
    });
  });

  describe('healthCheck', () => {
    it('returns healthy: true when pct exec returns exit 0', async () => {
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const record = await (async (): Promise<DeploymentRecord> => {
        const artifact = await backend.build(mkCtx());
        return backend.deploy(artifact, 'prod', { ...baseParams });
      })();
      const status = await backend.healthCheck(record);
      expect(status.healthy).toBe(true);
      expect(status.checks.length).toBeGreaterThanOrEqual(1);
    });

    it('returns healthy: false with unhealthyReason when pct exec fails', async () => {
      // Build/deploy succeed, but the subsequent healthCheck call fails.
      let phase: 'happy' | 'sick' = 'happy';
      const conn = mockProxmoxConnection({
        patterns: [
          { match: 'pct create', result: { stdout: 'ok', stderr: '', exitCode: 0 } },
          { match: 'pct start', result: { stdout: '', stderr: '', exitCode: 0 } },
          { match: 'pct status', result: { stdout: 'status: running', stderr: '', exitCode: 0 } },
        ],
        fallback: { stdout: '', stderr: '', exitCode: 0 },
      });
      // Override exec for the health probe phase.
      const originalExec = conn.exec.bind(conn);
      conn.exec = async (cmd: string) => {
        if (phase === 'sick' && cmd.includes('pct exec') && cmd.includes('/bin/true')) {
          conn.recordedCalls.push({ op: 'exec', args: [cmd] });
          return { stdout: '', stderr: 'unreachable', exitCode: 1, durationMs: 1 };
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
    it('returns success: false with no destructive calls when previous_vmid is null', async () => {
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact = await backend.build(mkCtx());
      const record = await backend.deploy(artifact, 'prod', { ...baseParams });
      // First deploy → previous_vmid is null.
      expect(record.payload.details['previous_vmid']).toBeNull();
      conn.recordedCalls.length = 0;
      const result = await backend.rollback(record);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // ZERO destructive calls.
      expect(conn.recordedCalls.filter((c) => c.op === 'exec')).toHaveLength(0);
    });

    it('rolls back successfully when previous_vmid is populated', async () => {
      // First deploy seeds the on-disk record.
      const conn = mockProxmoxConnection(happyExecMap());
      const backend = makeBackend(conn);
      const artifact1 = await backend.build(mkCtx());
      await backend.deploy(artifact1, 'prod', { ...baseParams });
      // Second deploy with same vmid sees previous_vmid !== null.
      const artifact2 = await backend.build(mkCtx({ requestId: 'req-2' }));
      expect(artifact2.metadata['previous_vmid']).toBe(100);
      const record2 = await backend.deploy(artifact2, 'prod', { ...baseParams });
      conn.recordedCalls.length = 0;
      const result = await backend.rollback(record2);
      expect(result.success).toBe(true);
      expect(result.restoredArtifactId).toBe('proxmox://pve-01/lxc/100');
      // Stop + start were issued.
      const ops = conn.recordedCalls.filter((c) => c.op === 'exec');
      expect((ops[0]?.args[0] as string)).toMatch(/^pct stop /);
      expect(ops.some((c) => (c.args[0] as string).startsWith('pct start '))).toBe(true);
    });
  });
});
