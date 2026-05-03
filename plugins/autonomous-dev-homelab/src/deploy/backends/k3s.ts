/**
 * `K3sHomelabBackend` per SPEC-002-3-02.
 *
 * Composition over inheritance: holds a private `K8sBackendLike` instance
 * and delegates all four interface methods after applying homelab defaults
 * and rewriting params. The wrapped instance's metadata is NOT exposed —
 * `K3sHomelabBackend.metadata.name === 'k3s'`.
 *
 * Cross-repo import resolution: SPEC-002-3-02 references `K8sBackend`
 * (autonomous-dev SPEC-024-1-03) as the parent class. The homelab repo
 * cannot import it directly. This file declares a local `K8sBackendLike`
 * structural interface; production wiring (when both repos are unified
 * via a shared package) injects the real `K8sBackend`. Tests inject a
 * mocked implementation. This keeps the homelab plugin compilable today
 * while preserving the contract from SPEC-002-3-02.
 */

import { DeployError } from '../errors.js';
import type {
  BackendMetadata,
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  ParamSchema,
  RollbackResult,
} from '../types.js';
import { validateParameters } from '../validate-parameters.js';
import type { K3sCredentialClient } from './k3s-credential-client.js';

export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  cluster_id: { type: 'string', required: true, format: 'identifier' },
  namespace: { type: 'string', default: 'default', format: 'identifier' },
  manifest_path: { type: 'string', required: true, format: 'path' },
  deployment_name: { type: 'string', required: true, format: 'identifier' },
  ready_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

/**
 * Structural interface mirroring autonomous-dev SPEC-024-1-03's
 * `K8sBackend`. All four methods accept the same shapes the homelab
 * backend forwards.
 */
export interface K8sBackendLike {
  build(ctx: BuildContext): Promise<BuildArtifact>;
  deploy(
    artifact: BuildArtifact,
    env: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord>;
  healthCheck(record: DeploymentRecord): Promise<HealthStatus>;
  rollback(record: DeploymentRecord): Promise<RollbackResult>;
}

export interface K3sBackendDeps {
  /** Wrapped autonomous-dev `K8sBackend` (or test stub). */
  k8sBackend: K8sBackendLike;
  /** Credential client (15-min scoped kubeconfig issuer). */
  credentialClient: K3sCredentialClient;
  /** Resolves cluster_id → kubeconfig context name. */
  resolveContextName: (clusterId: string) => Promise<string>;
}

export class K3sHomelabBackend implements DeploymentBackend {
  readonly metadata: BackendMetadata = {
    name: 'k3s',
    version: '0.1.0',
    supportedTargets: ['homelab-k3s'],
    capabilities: ['k3s-kubectl-apply'],
    requiredTools: [],
    minPlatformVersion: '1.24',
  };

  constructor(private readonly deps: K3sBackendDeps) {}

  async build(ctx: BuildContext): Promise<BuildArtifact> {
    return this.deps.k8sBackend.build(ctx);
  }

  async deploy(
    artifact: BuildArtifact,
    env: string,
    rawParams: DeployParameters,
  ): Promise<DeploymentRecord> {
    const params = validateParameters(rawParams, PARAM_SCHEMA);
    const clusterId = params['cluster_id'] as string;
    const namespace = (params['namespace'] as string | undefined) ?? 'default';
    const contextName = await this.deps.resolveContextName(clusterId);
    const cred = await this.deps.credentialClient.acquire({
      clusterId,
      op: 'K8s:Apply',
      scope: `cluster:${contextName}/namespace:${namespace}`,
    });
    const translated: DeployParameters = {
      ...params,
      context_name: contextName,
      namespace,
      scopedKubeconfig: cred.kubeconfig,
    };
    const inner = await this.deps.k8sBackend.deploy(artifact, env, translated);
    // Override the backendName so downstream code identifies this as a
    // k3s deploy (not a generic k8s deploy).
    return {
      payload: {
        ...inner.payload,
        backendName: 'k3s',
        details: {
          ...inner.payload.details,
          cluster_id: clusterId,
        },
      },
      hmac: inner.hmac,
    };
  }

  async healthCheck(record: DeploymentRecord): Promise<HealthStatus> {
    const details = record.payload.details as { cluster_id?: string; namespace?: string };
    if (details.cluster_id !== undefined) {
      const contextName = await this.deps.resolveContextName(details.cluster_id);
      await this.deps.credentialClient.acquire({
        clusterId: details.cluster_id,
        op: 'K8s:Read',
        scope: `cluster:${contextName}/namespace:${details.namespace ?? 'default'}`,
      });
    }
    return this.deps.k8sBackend.healthCheck(record);
  }

  async rollback(record: DeploymentRecord): Promise<RollbackResult> {
    const details = record.payload.details as { cluster_id?: string; namespace?: string };
    if (details.cluster_id === undefined) {
      throw new DeployError({
        code: 'ROLLBACK_FAILED',
        message: 'k3s rollback requires details.cluster_id to be set on the record',
      });
    }
    const contextName = await this.deps.resolveContextName(details.cluster_id);
    await this.deps.credentialClient.acquire({
      clusterId: details.cluster_id,
      op: 'K8s:Patch',
      scope: `cluster:${contextName}/namespace:${details.namespace ?? 'default'}`,
    });
    return this.deps.k8sBackend.rollback(record);
  }
}
