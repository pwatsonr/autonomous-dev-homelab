/**
 * `UnraidHomelabBackend` per SPEC-002-3-01.
 *
 * Deploys Docker containers via Unraid's `emhttp` HTTP API; persistent
 * storage is backed by Unraid array shares supplied via `params.storage_mounts`.
 * Every emhttp call flows through the injected `UnraidEmhttpClient` —
 * the backend never invokes `child_process` directly.
 */

import { DeployError } from '../errors.js';
import {
  persistSignedRecord,
  readSignedRecord,
} from '../persist-record.js';
import { unraidRecordPath } from '../state-paths.js';
import { signDeploymentRecord } from '../sign-record.js';
import {
  UnraidEmhttpClient,
  type AddContainerPayload,
  type ContainerInspect,
} from './unraid-emhttp-client.js';
import { pullImage } from './registry-pull.js';
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
  host_id: { type: 'string', required: true, format: 'identifier' },
  container_name: { type: 'string', required: true, format: 'identifier' },
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },
  registry_url: { type: 'string', required: false, format: 'url' },
  network_mode: { type: 'string', default: 'bridge', enum: ['bridge', 'host', 'none'] },
  port_mappings: {
    type: 'array',
    default: [],
    items: { type: 'string', regex: /^\d{1,5}:\d{1,5}(\/(tcp|udp))?$/ },
  },
  storage_mounts: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        host_path: { type: 'string', required: true, format: 'absolute-path' },
        container_path: { type: 'string', required: true, format: 'absolute-path' },
        readonly: { type: 'boolean', default: false },
      },
    },
  },
  env: {
    type: 'object',
    default: {},
    additionalProperties: { type: 'string' },
  },
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

interface PreviousContainerCapture {
  container_name: string;
  config: Record<string, unknown> | null;
}

export interface UnraidBackendDeps {
  /** Resolves the emhttp client for a given Unraid host id. */
  getClient: (hostId: string) => Promise<UnraidEmhttpClient>;
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

interface StorageMount {
  host_path: string;
  container_path: string;
  readonly?: boolean;
}

export class UnraidHomelabBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'unraid',
    version: '0.1.0',
    supportedTargets: ['homelab-unraid'],
    capabilities: ['unraid-docker'],
    requiredTools: [],
  };

  private readonly deps: Required<UnraidBackendDeps>;

  constructor(deps: UnraidBackendDeps) {
    this.deps = {
      getClient: deps.getClient,
      sleep: deps.sleep ?? defaultSleep,
      now: deps.now ?? Date.now,
      generateId: deps.generateId ?? (() => `unraid-${Date.now().toString(36)}`),
    };
  }

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    const params = validateParameters(ctx.params, PARAM_SCHEMA);
    const hostId = params['host_id'] as string;
    const containerName = params['container_name'] as string;
    const imageUri = params['image_uri'] as string;
    const client = await this.deps.getClient(hostId);

    // Use shared registry-pull helper (handles retries + backoff).
    const pullResult = await pullImage({
      image: imageUri,
      ...(params['registry_url'] !== undefined
        ? { registry: params['registry_url'] as string }
        : {}),
      driver: async (image): Promise<{
        success: boolean;
        digest?: string;
        sizeBytes?: number;
        transient?: boolean;
        error?: string;
      }> => {
        try {
          const accepted = await client.pullImage(image);
          if (!accepted.accepted) {
            return { success: false, transient: true, error: 'pull request rejected' };
          }
          const status = await client.pullStatus(image);
          if (status.status === 'complete') {
            return { success: true, digest: status.digest, sizeBytes: status.sizeBytes };
          }
          if (status.status === 'failed') {
            return { success: false, transient: false, error: status.error ?? 'pull failed' };
          }
          // in-progress is treated as transient so the retry loop polls again
          return { success: false, transient: true, error: 'pull in-progress' };
        } catch (err) {
          return {
            success: false,
            transient: true,
            error: (err as Error).message,
          };
        }
      },
      sleep: this.deps.sleep,
      now: this.deps.now,
    });

    // Capture existing container's config for rollback.
    let previousConfig: Record<string, unknown> | null = null;
    const inspect = await client.inspectContainer(containerName);
    if (inspect !== null && inspect.config !== undefined) {
      previousConfig = inspect.config;
    }

    return {
      type: 'docker-image',
      location: `docker://${imageUri}@${pullResult.digest}`,
      checksum: pullResult.digest,
      sizeBytes: pullResult.sizeBytes,
      metadata: {
        host_id: hostId,
        container_name: containerName,
        image_uri: imageUri,
        digest: pullResult.digest,
        previous_container_config: previousConfig,
      },
    };
  }

  async deploy(
    artifact: BuildArtifact,
    env: string,
    rawParams: DeployParameters,
  ): Promise<DeploymentRecord> {
    const params = validateParameters(rawParams, PARAM_SCHEMA);
    const hostId = params['host_id'] as string;
    const containerName = params['container_name'] as string;
    const client = await this.deps.getClient(hostId);

    const storageMounts = (params['storage_mounts'] as StorageMount[] | undefined) ?? [];

    // Validate every mount's host_path against the cached shares list.
    if (storageMounts.length > 0) {
      const shares = await client.getShares();
      for (const mount of storageMounts) {
        const ok = shares.some((sharePath) =>
          mount.host_path === sharePath || mount.host_path.startsWith(`${sharePath}/`),
        );
        if (!ok) {
          throw new DeployError({
            code: 'INVALID_PARAMS',
            message: `storage_mounts[].host_path '${mount.host_path}' is not under any Unraid share`,
          });
        }
      }
    }

    // STOP the existing container BEFORE adding the new one.
    const existing = await client.inspectContainer(containerName);
    if (existing !== null) {
      await client.stopContainer(containerName);
    }

    const payload: AddContainerPayload = {
      name: containerName,
      image: `${artifact.metadata['image_uri'] as string}@${artifact.metadata['digest'] as string}`,
      network_mode: (params['network_mode'] as string | undefined) ?? 'bridge',
      ports: (params['port_mappings'] as string[] | undefined) ?? [],
      volumes: storageMounts,
      env: (params['env'] as Record<string, string> | undefined) ?? {},
    };
    await client.addContainer(payload);
    await client.startContainer(containerName);
    await this.pollForRunning(client, containerName, 60_000);

    const previousConfig =
      (artifact.metadata['previous_container_config'] as Record<string, unknown> | null | undefined) ??
      null;
    const startedAt = new Date(this.deps.now()).toISOString();

    const recordPayload = {
      id: this.deps.generateId(),
      backendName: 'unraid',
      target: 'homelab-unraid',
      envName: env,
      artifactLocation: artifact.location,
      details: {
        host_id: hostId,
        container_name: containerName,
        image_uri: artifact.metadata['image_uri'] as string,
        digest: artifact.metadata['digest'] as string,
        previous_container_config: previousConfig,
        started_at: startedAt,
      },
      deployedAt: startedAt,
    };

    await persistSignedRecord<PreviousContainerCapture>(unraidRecordPath(containerName), {
      container_name: containerName,
      config: previousConfig,
    });
    // Touch readSignedRecord so the import isn't dead-code-eliminated by the
    // bundler in callers that exercise the rollback path through a separate
    // module. The deploy path itself does not need to read.
    void readSignedRecord;

    return signDeploymentRecord(recordPayload);
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const details = record.payload.details as {
      host_id: string;
      container_name: string;
    };
    const client = await this.deps.getClient(details.host_id);
    const start = this.deps.now();
    let outcome: 'success' | 'failure' = 'failure';
    let detail: string | undefined;
    try {
      const inspect = await client.inspectContainer(details.container_name);
      if (inspect === null) {
        detail = `container ${details.container_name} not found`;
      } else {
        const status = inspect.state.health?.status;
        if (status === 'healthy') {
          outcome = 'success';
        } else {
          detail = `state.health.status=${status ?? 'unknown'}`;
        }
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
      host_id: string;
      container_name: string;
      previous_container_config: Record<string, unknown> | null;
    };
    if (details.previous_container_config === null || details.previous_container_config === undefined) {
      return { success: false, errors: ['no previous container to roll back to'] };
    }
    const client = await this.deps.getClient(details.host_id);
    const errors: string[] = [];
    try {
      await client.stopContainer(details.container_name);
      await client.removeContainer(details.container_name);
      await client.addContainer(details.previous_container_config);
      await client.startContainer(details.container_name);
      await this.pollForRunning(client, details.container_name, 60_000);
    } catch (err) {
      errors.push((err as Error).message);
      return { success: false, errors };
    }
    const previousImage =
      (details.previous_container_config['image'] as string | undefined) ?? 'unknown';
    return {
      success: true,
      restoredArtifactId: `docker://${previousImage}`,
      errors,
    };
  }

  // -- private helpers ----------------------------------------------------

  private async pollForRunning(
    client: UnraidEmhttpClient,
    containerName: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = this.deps.now() + timeoutMs;
    while (this.deps.now() < deadline) {
      const inspect: ContainerInspect | null = await client.inspectContainer(containerName);
      if (inspect !== null && inspect.state.running === true) return;
      await this.deps.sleep(2000);
    }
    throw new DeployError({
      code: 'DEPLOY_FAILED',
      message: `container ${containerName} did not reach running within ${timeoutMs}ms`,
    });
  }
}
