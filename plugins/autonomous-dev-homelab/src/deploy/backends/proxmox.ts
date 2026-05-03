/**
 * `ProxmoxHomelabBackend` per SPEC-002-3-01.
 *
 * Deploys via Proxmox CLIs (`pct create` for LXC, `qm create` for VMs)
 * over SSH using the homelab `ProxmoxConnection` (PLAN-001-2). All shell
 * execution flows through `Connection.exec` — never `child_process`
 * directly — so the audit-wrapping in `ConnectionPool.installExecAuditing`
 * captures every command the backend issues.
 */

import { createHash } from 'node:crypto';
import type { Connection } from '../../connection/base.js';
import { DeployError } from '../errors.js';
import {
  persistSignedRecord,
  readSignedRecord,
} from '../persist-record.js';
import { proxmoxRecordPath } from '../state-paths.js';
import { signDeploymentRecord } from '../sign-record.js';
import {
  getContainerStatus,
  parseIpJson,
  parseVmid,
  runPctCreate,
  runQmCreate,
  type WorkloadKind,
} from './proxmox-cli.js';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthCheckProbe,
  HealthStatus,
  ParamSchema,
  RollbackResult,
} from '../types.js';
import { validateParameters } from '../validate-parameters.js';

export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  node_id: { type: 'string', required: true, format: 'identifier' },
  workload_kind: { type: 'string', required: true, enum: ['lxc', 'vm'] },
  vmid: { type: 'number', required: true, range: [100, 999999] },
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },
  registry_url: { type: 'string', required: false, format: 'url' },
  storage_pool: { type: 'string', required: true, format: 'identifier' },
  hostname: { type: 'string', required: true, format: 'identifier' },
  ip_cidr: { type: 'string', required: false, regex: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/ },
  cores: { type: 'number', default: 1, range: [1, 64] },
  memory_mb: { type: 'number', default: 512, range: [128, 524288] },
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

interface PreviousRecord {
  vmid: number;
  workload_kind: WorkloadKind;
  hostname: string;
  image_uri: string;
}

export interface ProxmoxBackendDeps {
  /**
   * Resolves a `Connection` for a given Proxmox node id. The pool from
   * PLAN-001-2 is the production wiring; tests inject a function returning
   * a mocked connection.
   */
  getConnection: (nodeId: string) => Promise<Connection>;
  /** Sleep injection for status polling. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection. */
  now?: () => number;
  /** Optional async fetch for `health_url` polling. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>;
  /** Bound `Date` source for ULID-style ids in records. */
  generateId?: () => string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export class ProxmoxHomelabBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'proxmox',
    version: '0.1.0',
    supportedTargets: ['homelab-proxmox'],
    capabilities: ['lxc-create', 'qm-create'],
    requiredTools: [],
    minPlatformVersion: '7.0',
  };

  private readonly deps: Required<Omit<ProxmoxBackendDeps, 'fetchImpl'>> & {
    fetchImpl?: ProxmoxBackendDeps['fetchImpl'];
  };

  constructor(deps: ProxmoxBackendDeps) {
    this.deps = {
      getConnection: deps.getConnection,
      sleep: deps.sleep ?? defaultSleep,
      now: deps.now ?? Date.now,
      generateId: deps.generateId ?? (() => `prox-${Date.now().toString(36)}`),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    };
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const params = validateParameters(ctx.params, PARAM_SCHEMA);
    const vmid = parseVmid(params['vmid']);
    if (vmid < 100) {
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `vmid ${vmid} is in Proxmox's reserved range (< 100)`,
      });
    }
    const nodeId = params['node_id'] as string;
    const kind = params['workload_kind'] as WorkloadKind;
    const conn = await this.deps.getConnection(nodeId);

    const cores = (params['cores'] as number | undefined) ?? 1;
    const memoryMb = (params['memory_mb'] as number | undefined) ?? 512;
    const ipCidr = params['ip_cidr'] as string | undefined;

    if (kind === 'lxc') {
      await runPctCreate(conn, {
        vmid,
        imageUri: params['image_uri'] as string,
        storagePool: params['storage_pool'] as string,
        hostname: params['hostname'] as string,
        cores,
        memoryMb,
        ...(ipCidr !== undefined ? { ipCidr } : {}),
      });
    } else {
      await runQmCreate(conn, {
        vmid,
        hostname: params['hostname'] as string,
        cores,
        memoryMb,
        imageUri: params['image_uri'] as string,
        storagePool: params['storage_pool'] as string,
      });
    }

    // Capture previous record (if any) for rollback.
    let previousVmid: number | null = null;
    try {
      const prev = await readSignedRecord<PreviousRecord>(proxmoxRecordPath(vmid));
      if (prev !== null) previousVmid = prev.vmid;
    } catch {
      previousVmid = null;
    }

    const checksumInput = `${nodeId}:${kind}:${vmid}:${params['image_uri'] as string}:${ctx.commitSha}`;
    const checksum = createHash('sha256').update(checksumInput).digest('hex');

    return {
      type: 'proxmox-instance',
      location: `proxmox://${nodeId}/${kind}/${vmid}`,
      checksum,
      sizeBytes: 0,
      metadata: {
        node_id: nodeId,
        vmid,
        workload_kind: kind,
        hostname: params['hostname'] as string,
        image_uri: params['image_uri'] as string,
        ...(params['registry_url'] !== undefined
          ? { registry_url: params['registry_url'] as string }
          : {}),
        previous_vmid: previousVmid,
      },
    };
  }

  async deploy(
    artifact: BuildArtifact,
    env: string,
    rawParams: DeployParameters,
  ): Promise<DeploymentRecord> {
    const params = validateParameters(rawParams, PARAM_SCHEMA);
    const vmid = parseVmid(params['vmid']);
    if (vmid < 100) {
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `vmid ${vmid} is in Proxmox's reserved range (< 100)`,
      });
    }
    const nodeId = params['node_id'] as string;
    const kind = params['workload_kind'] as WorkloadKind;
    const conn = await this.deps.getConnection(nodeId);

    const startCmd = kind === 'lxc' ? `pct start ${vmid}` : `qm start ${vmid}`;
    const startResult = await conn.exec(startCmd);
    if (startResult.exitCode !== 0) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: (startResult.stderr || startResult.stdout).slice(0, 500),
      });
    }
    await this.pollForRunning(conn, kind, vmid, 60_000);

    const ip = await this.resolveAssignedIp(conn, kind, vmid);

    const previousVmid =
      (artifact.metadata['previous_vmid'] as number | null | undefined) ?? null;
    const startedAt = new Date(this.deps.now()).toISOString();

    const recordId = this.deps.generateId();
    const recordPayload = {
      id: recordId,
      backendName: 'proxmox',
      target: 'homelab-proxmox',
      envName: env,
      artifactLocation: artifact.location,
      details: {
        node_id: nodeId,
        vmid,
        workload_kind: kind,
        ip,
        hostname: params['hostname'] as string,
        image_uri: params['image_uri'] as string,
        previous_vmid: previousVmid,
        started_at: startedAt,
      },
      deployedAt: startedAt,
    };

    // Persist a SEPARATE on-disk record for rollback lookup. This record
    // mirrors `details` but is keyed by vmid (not deploy id) so the next
    // build can resolve `previous_vmid`.
    await persistSignedRecord<PreviousRecord>(proxmoxRecordPath(vmid), {
      vmid,
      workload_kind: kind,
      hostname: params['hostname'] as string,
      image_uri: params['image_uri'] as string,
    });

    return signDeploymentRecord(recordPayload);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const details = record.payload.details as {
      node_id: string;
      vmid: number;
      workload_kind: WorkloadKind;
    };
    const conn = await this.deps.getConnection(details.node_id);
    const checks: HealthCheckProbe[] = [];

    // Single-shot probe per call. Real cadence is owned by upstream
    // schedulers; this method records ONE probe attempt and returns.
    const start = this.deps.now();
    let outcome: 'success' | 'failure' = 'failure';
    let detail: string | undefined;
    try {
      if (details.workload_kind === 'lxc') {
        const result = await conn.exec(`pct exec ${details.vmid} -- /bin/true`);
        outcome = result.exitCode === 0 ? 'success' : 'failure';
        if (result.exitCode !== 0) detail = (result.stderr || result.stdout).slice(0, 200);
      } else {
        const result = await conn.exec(`qm guest cmd ${details.vmid} ping`);
        outcome = result.exitCode === 0 ? 'success' : 'failure';
        if (result.exitCode !== 0) detail = (result.stderr || result.stdout).slice(0, 200);
      }
    } catch (err) {
      detail = (err as Error).message;
    }
    const probe: HealthCheckProbe = {
      timestamp: new Date(this.deps.now()).toISOString(),
      outcome,
      latencyMs: this.deps.now() - start,
      ...(detail !== undefined ? { detail } : {}),
    };
    checks.push(probe);

    return {
      healthy: outcome === 'success',
      checks: checks.slice(-5),
      ...(outcome === 'failure' && detail !== undefined
        ? { unhealthyReason: detail }
        : {}),
    };
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const details = record.payload.details as {
      node_id: string;
      vmid: number;
      workload_kind: WorkloadKind;
      previous_vmid: number | null;
    };
    if (details.previous_vmid === null || details.previous_vmid === undefined) {
      return { success: false, errors: ['no previous record to roll back to'] };
    }
    const conn = await this.deps.getConnection(details.node_id);
    const errors: string[] = [];

    const stopCmd = details.workload_kind === 'lxc'
      ? `pct stop ${details.vmid}`
      : `qm stop ${details.vmid}`;
    const stopResult = await conn.exec(stopCmd);
    if (stopResult.exitCode !== 0) {
      errors.push(`stop failed: ${(stopResult.stderr || stopResult.stdout).slice(0, 200)}`);
    }
    const startCmd = details.workload_kind === 'lxc'
      ? `pct start ${details.previous_vmid}`
      : `qm start ${details.previous_vmid}`;
    const startResult = await conn.exec(startCmd);
    if (startResult.exitCode !== 0) {
      errors.push(`start failed: ${(startResult.stderr || startResult.stdout).slice(0, 200)}`);
      return { success: false, errors };
    }
    try {
      await this.pollForRunning(conn, details.workload_kind, details.previous_vmid, 60_000);
    } catch (err) {
      errors.push((err as Error).message);
      return { success: false, errors };
    }
    return {
      success: errors.length === 0,
      restoredArtifactId: `proxmox://${details.node_id}/${details.workload_kind}/${details.previous_vmid}`,
      errors,
    };
  }

  // -- private helpers ----------------------------------------------------

  private async pollForRunning(
    conn: Connection,
    kind: WorkloadKind,
    vmid: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.now() < deadline) {
      const status = await getContainerStatus(conn, kind, vmid);
      if (status === 'running') return;
      await this.deps.sleep(2000);
    }
    throw new DeployError({
      code: 'DEPLOY_FAILED',
      message: `vmid ${vmid} did not reach 'running' within ${timeoutMs}ms`,
    });
  }

  private async resolveAssignedIp(
    conn: Connection,
    kind: WorkloadKind,
    vmid: number,
  ): Promise<string | null> {
    if (kind === 'lxc') {
      const result = await conn.exec(`pct exec ${vmid} -- ip -j addr show eth0`);
      if (result.exitCode !== 0) return null;
      const parsed = parseIpJson(result.stdout);
      return parsed?.ip ?? null;
    }
    const result = await conn.exec(`qm guest cmd ${vmid} network-get-interfaces`);
    if (result.exitCode !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        'ip-addresses'?: Array<{ 'ip-address-type'?: string; 'ip-address'?: string }>;
      }>;
      for (const iface of parsed) {
        const addrs = iface['ip-addresses'] ?? [];
        for (const a of addrs) {
          if (a['ip-address-type'] === 'ipv4' && typeof a['ip-address'] === 'string' && a['ip-address'] !== '127.0.0.1') {
            return a['ip-address'];
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  }
}
