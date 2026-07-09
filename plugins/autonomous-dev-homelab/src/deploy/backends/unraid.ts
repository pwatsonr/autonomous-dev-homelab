/**
 * `UnraidHomelabBackend` per SPEC-002-3-01.
 *
 * Deploys Docker containers via Unraid's `emhttp` HTTP API; persistent
 * storage is backed by Unraid array shares supplied via `params.storage_mounts`.
 * Every emhttp call flows through the injected `UnraidEmhttpClient` —
 * the backend never invokes `child_process` directly.
 *
 * Stateful-awareness (issue #33):
 *   When the deploy target is stateful (role ∈ {database, cache} or the spec
 *   declares storage mounts), the deploy path:
 *     1. Requires a fresh verified backup via `verifyBackup` BEFORE proceeding.
 *        If no fresh backup exists, the deploy is BLOCKED with a clear error.
 *     2. Does NOT destroy existing storage mounts — mounts are preserved and
 *        reused, so data on the host path survives the container replacement.
 *   Stateless deploys are unaffected (no new backup requirement).
 *   The backup gate respects the existing safety gate: `verifyBackup` from
 *   `src/backup/orchestrator.ts` is the same function used by `gate.ts`.
 *
 * Invariant #62: stateful detection is entirely attribute-driven (role +
 * declared storage mounts). No hard-coded service names appear in this file.
 */

import { DeployError } from '../errors.js';
import {
  persistSignedRecord,
  readSignedRecord,
} from '../persist-record.js';
import { unraidRecordPath } from '../state-paths.js';
import { signDeploymentRecord } from '../sign-record.js';
import {
  isStatefulTarget,
  DEFAULT_STATEFUL_CONFIG,
  type StatefulDeployConfig,
} from '../stateful-target.js';
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
import type { BackupVerificationResult } from '../../backup/types.js';
import type { VerifyInput } from '../../backup/orchestrator.js';

/**
 * Minimal `verifyBackup` signature used by the backend. Injected via deps so
 * tests can mock it without touching the filesystem.
 */
export type VerifyBackupFn = (input: VerifyInput) => Promise<BackupVerificationResult>;

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
  /**
   * Optional role attribute (from the discovery role catalog, issue #28).
   * When set to a stateful role (e.g. "database", "cache"), the deploy path
   * activates storage-mount preservation + backup gating (issue #33).
   * Invariant #62: role is a generic attribute, never a service name.
   */
  role: { type: 'string', required: false },
  /**
   * Optional backup platform key used when calling `verifyBackup`.
   * Defaults to "unraid" when absent. Operators set this to match the
   * platform string used by the backup engine (e.g. "postgres", "redis").
   */
  backup_platform: { type: 'string', required: false },
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
  /**
   * Optional `verifyBackup` override. Defaults to the real orchestrator
   * function. Inject a mock in tests to avoid filesystem access.
   */
  verifyBackup?: VerifyBackupFn;
  /**
   * Optional stateful-deploy config. Defaults to `DEFAULT_STATEFUL_CONFIG`
   * (requireBackup=true). Supply `{ requireBackup: false }` for admin bypass;
   * this must be an EXPLICIT caller decision — never a silent default.
   */
  statefulConfig?: StatefulDeployConfig;
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
      verifyBackup: deps.verifyBackup ?? defaultVerifyBackup,
      statefulConfig: deps.statefulConfig ?? DEFAULT_STATEFUL_CONFIG,
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
    const role = params['role'] as string | undefined;
    const backupPlatform = (params['backup_platform'] as string | undefined) ?? 'unraid';
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

    // Stateful-awareness gate (issue #33).
    // Detection is by role/attributes only — invariant #62.
    // Note: storage_mounts with host_path entries trigger stateful classification.
    const stateful = isStatefulTarget({ role, storage_mounts: storageMounts });
    if (stateful && this.deps.statefulConfig.requireBackup) {
      // Backup gate: BLOCK the deploy if no fresh verified backup exists.
      // This mirrors the data-affecting path in src/safety/gate.ts — the same
      // verifyBackup function is used, so the gate is not bypassed.
      await this.deps.verifyBackup({
        platform: backupPlatform,
        target: containerName,
        freshnessOverrides: this.deps.statefulConfig.backupFreshnessOverrides,
      });
      // Storage-mount preservation: existing mounts are NOT destroyed before
      // the redeploy. We stop the old container (to release file locks), swap
      // the image with addContainer, then start. The host_path directories
      // remain intact because we never call rm -rf or equivalent on them.
      // The emhttp API only manages container lifecycle — the underlying share
      // data on the array is untouched.
    }

    // Capture the previous config before any destructive operation.
    const previousConfig =
      (artifact.metadata['previous_container_config'] as Record<string, unknown> | null | undefined) ??
      null;

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
    try {
      await client.addContainer(payload);
      await client.startContainer(containerName);
      await this.pollForRunning(client, containerName, 60_000);
    } catch (err) {
      // The new container failed to start. If a previous config was captured,
      // attempt to restore it so the host is not left with no running service.
      if (previousConfig !== null) {
        const rollbackResult = await this.attemptRollback(client, containerName, previousConfig);
        throw new DeployError({
          code: 'DEPLOY_FAILED',
          message: (err as Error).message,
          details: {
            rollback_attempted: true,
            rollback_success: rollbackResult.success,
            rollback_errors: rollbackResult.errors,
          },
        });
      }
      throw err;
    }

    const startedAt = new Date(this.deps.now()).toISOString();

    const recordPayload = {
      id: this.deps.generateId(),
      backendName: 'unraid',
      target: 'homelab-unraid',
      envName: env,
      artifactLocation: artifact.location,
      stateful,
      details: {
        host_id: hostId,
        container_name: containerName,
        image_uri: artifact.metadata['image_uri'] as string,
        digest: artifact.metadata['digest'] as string,
        previous_container_config: previousConfig,
        started_at: startedAt,
        ...(stateful ? { backup_platform: backupPlatform } : {}),
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
    return this.attemptRollback(client, details.container_name, details.previous_container_config);
  }

  // -- private helpers ----------------------------------------------------

  /**
   * Internal rollback helper shared by `rollback()` and the deploy error path.
   * Stops + removes the current container, re-adds the previous config, and
   * polls until the container is running.
   */
  private async attemptRollback(
    client: UnraidEmhttpClient,
    containerName: string,
    previousConfig: Record<string, unknown>,
  ): Promise<RollbackResult> {
    const errors: string[] = [];
    try {
      await client.stopContainer(containerName);
      await client.removeContainer(containerName);
      await client.addContainer(previousConfig);
      await client.startContainer(containerName);
      await this.pollForRunning(client, containerName, 60_000);
    } catch (err) {
      errors.push((err as Error).message);
      return { success: false, errors };
    }
    const previousImage = (previousConfig['image'] as string | undefined) ?? 'unknown';
    return {
      success: true,
      restoredArtifactId: `docker://${previousImage}`,
      errors,
    };
  }

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

/**
 * Default `verifyBackup` implementation: delegates to the real backup
 * orchestrator. Imported lazily to avoid circular deps when mocked in tests.
 */
async function defaultVerifyBackup(input: VerifyInput): Promise<BackupVerificationResult> {
  const { verifyBackup } = await import('../../backup/orchestrator.js');
  return verifyBackup(input);
}
