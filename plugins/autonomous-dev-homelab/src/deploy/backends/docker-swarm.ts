/**
 * `DockerSwarmHomelabBackend` per SPEC-002-3-02.
 *
 * `build` is a NO-OP — the Swarm cluster pulls images at deploy time, so
 * this backend never builds or pushes images locally. `deploy` runs
 * `docker stack deploy` over SSH against a Swarm manager.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Connection } from '../../connection/base.js';
import { DeployError } from '../errors.js';
import { signDeploymentRecord } from '../sign-record.js';
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
  manager_id: { type: 'string', required: true, format: 'identifier' },
  stack_name: { type: 'string', required: true, regex: /^[a-z0-9][a-z0-9_-]{0,62}$/ },
  compose_file_path: { type: 'string', required: true, format: 'path' },
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },
  service_name: { type: 'string', required: true, format: 'identifier' },
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

export interface SwarmBackendDeps {
  getConnection: (managerId: string) => Promise<Connection>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  generateId?: () => string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

export class DockerSwarmHomelabBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'docker-swarm',
    version: '0.1.0',
    supportedTargets: ['homelab-docker-swarm'],
    capabilities: ['docker-stack-deploy'],
    requiredTools: [],
  };

  private readonly deps: Required<SwarmBackendDeps>;

  constructor(deps: SwarmBackendDeps) {
    this.deps = {
      getConnection: deps.getConnection,
      sleep: deps.sleep ?? defaultSleep,
      now: deps.now ?? Date.now,
      generateId: deps.generateId ?? (() => `swarm-${Date.now().toString(36)}`),
    };
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const params = validateParameters(ctx.params, PARAM_SCHEMA);
    const stackName = params['stack_name'] as string;
    // Reproducible checksum: same context + params → same artifact.
    const checksumInput = `${ctx.commitSha}:${ctx.requestId}`;
    const checksum = createHash('sha256').update(checksumInput).digest('hex');
    return {
      type: 'commit',
      location: ctx.commitSha,
      checksum,
      sizeBytes: 0,
      metadata: { kind: 'docker-stack-ref', stack_name: stackName },
    };
  }

  async deploy(
    artifact: BuildArtifact,
    env: string,
    rawParams: DeployParameters,
  ): Promise<DeploymentRecord> {
    const params = validateParameters(rawParams, PARAM_SCHEMA);
    const managerId = params['manager_id'] as string;
    const stackName = params['stack_name'] as string;
    const serviceName = params['service_name'] as string;
    const composePath = params['compose_file_path'] as string;

    // Path traversal guard: compose path must resolve inside repoPath.
    // The deploy contract does not pass `repoPath` directly; the resolved
    // absolute path must not contain traversal segments AND must be a
    // bare path (no `..` after normalisation).
    const normalised = path.posix.normalize(composePath);
    if (normalised.startsWith('../') || normalised.includes('/../') || normalised === '..') {
      throw new DeployError({
        code: 'INVALID_PARAMS',
        message: `compose_file_path '${composePath}' resolves outside the repo root`,
      });
    }

    const conn = await this.deps.getConnection(managerId);

    // Capture previous service spec (if any).
    const inspectCmd = `docker service inspect ${stackName}_${serviceName}`;
    const inspectResult = await conn.exec(inspectCmd);
    let previousServiceSpec: unknown = null;
    if (inspectResult.exitCode === 0) {
      try {
        previousServiceSpec = JSON.parse(inspectResult.stdout);
      } catch {
        previousServiceSpec = null;
      }
    }

    const deployCmd = `docker stack deploy --compose-file ${composePath} --with-registry-auth ${stackName}`;
    const deployResult = await conn.exec(deployCmd);
    if (deployResult.exitCode !== 0) {
      throw new DeployError({
        code: 'DEPLOY_FAILED',
        message: (deployResult.stderr || deployResult.stdout).slice(0, 500),
      });
    }

    const deployedAt = new Date(this.deps.now()).toISOString();
    return signDeploymentRecord({
      id: this.deps.generateId(),
      backendName: 'docker-swarm',
      target: 'homelab-docker-swarm',
      envName: env,
      artifactLocation: artifact.location,
      details: {
        manager_id: managerId,
        stack_name: stackName,
        service_name: serviceName,
        image_uri: params['image_uri'] as string,
        previous_service_spec: previousServiceSpec,
        deployed_at: deployedAt,
      },
      deployedAt,
    });
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const details = record.payload.details as {
      manager_id: string;
      stack_name: string;
      service_name: string;
    };
    const conn = await this.deps.getConnection(details.manager_id);
    const start = this.deps.now();
    let outcome: 'success' | 'failure' = 'failure';
    let detail: string | undefined;

    const psCmd = `docker service ps ${details.stack_name}_${details.service_name} --format json --no-trunc`;
    const inspectCmd = `docker service inspect ${details.stack_name}_${details.service_name}`;
    try {
      const psResult = await conn.exec(psCmd);
      const inspectResult = await conn.exec(inspectCmd);
      if (psResult.exitCode === 0 && inspectResult.exitCode === 0) {
        const tasks = parseJsonLines(psResult.stdout);
        const failedTask = tasks.find(
          (t) => typeof t.CurrentState === 'string' && t.CurrentState.toLowerCase().startsWith('failed'),
        );
        const runningCount = tasks.filter(
          (t) => typeof t.CurrentState === 'string' && t.CurrentState.toLowerCase().startsWith('running'),
        ).length;
        const replicas = parseReplicaCount(inspectResult.stdout);
        if (failedTask !== undefined) {
          detail = (failedTask.Error as string | undefined) ?? 'task failed';
        } else if (runningCount === replicas && replicas > 0) {
          outcome = 'success';
        } else {
          detail = `${runningCount}/${replicas} tasks running`;
        }
      } else {
        detail = 'service inspect failed';
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
    return {
      healthy: outcome === 'success',
      checks: [probe],
      ...(outcome === 'failure' && detail !== undefined ? { unhealthyReason: detail } : {}),
    };
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const details = record.payload.details as {
      manager_id: string;
      stack_name: string;
      service_name: string;
      previous_service_spec: unknown;
    };
    if (details.previous_service_spec === null || details.previous_service_spec === undefined) {
      return { success: false, errors: ['no previous service spec to roll back to'] };
    }
    const conn = await this.deps.getConnection(details.manager_id);
    const errors: string[] = [];
    const rollbackCmd = `docker service rollback ${details.stack_name}_${details.service_name}`;
    const rollbackResult = await conn.exec(rollbackCmd);
    if (rollbackResult.exitCode !== 0) {
      errors.push((rollbackResult.stderr || rollbackResult.stdout).slice(0, 200));
      return { success: false, errors };
    }
    // Poll UpdateStatus.State until 'completed' (90s timeout).
    const deadline = this.deps.now() + 90_000;
    const stateCmd = `docker service inspect ${details.stack_name}_${details.service_name} --format '{{.UpdateStatus.State}}'`;
    while (this.deps.now() < deadline) {
      const stateResult = await conn.exec(stateCmd);
      if (stateResult.exitCode === 0 && stateResult.stdout.trim().toLowerCase() === 'completed') {
        return {
          success: true,
          restoredArtifactId: `docker-swarm://${details.manager_id}/${details.stack_name}/${details.service_name}@previous`,
          errors,
        };
      }
      await this.deps.sleep(2000);
    }
    errors.push('rollback did not complete within 90s');
    return { success: false, errors };
  }
}

interface SwarmTask {
  CurrentState?: string;
  Error?: string;
}

function parseJsonLines(stdout: string): SwarmTask[] {
  const out: SwarmTask[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as SwarmTask);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

function parseReplicaCount(inspectStdout: string): number {
  try {
    const parsed = JSON.parse(inspectStdout) as Array<{
      Spec?: { Mode?: { Replicated?: { Replicas?: number } } };
    }>;
    const replicas = parsed[0]?.Spec?.Mode?.Replicated?.Replicas;
    return typeof replicas === 'number' ? replicas : 0;
  } catch {
    return 0;
  }
}
