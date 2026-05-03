/**
 * LOCAL DeploymentBackend contract for the homelab plugin.
 *
 * The "real" `DeploymentBackend` lives in autonomous-dev's SPEC-023-1-01
 * (`plugins/autonomous-dev/intake/deploy/types.ts`). This homelab repo
 * cannot directly import across the package boundary, so we mirror the
 * structure here. Future work: extract the contract into a shared package
 * (e.g. `@autonomous-dev/deploy-contract`) and have both sides depend on
 * it; for now the local copy keeps the homelab plugin self-contained
 * without forking behavior.
 *
 * Implements SPEC-002-3-01.
 */

export interface BackendMetadata {
  name: string;
  version: string;
  /** Inventory entry types this backend can target (PLAN-001-1). */
  supportedTargets: string[];
  /** Free-form capability tags. */
  capabilities: string[];
  /** Tools required ON THE DAEMON HOST (not the remote). Empty when the backend shells over a connection. */
  requiredTools: string[];
  /** Optional minimum platform version (recorded for connection-test surfacing). */
  minPlatformVersion?: string;
}

/**
 * Minimal `ParamSchema` recogniser used by `validateParameters`. Mirrors the
 * shape used by autonomous-dev SPEC-023-1-01 for the subset of validators
 * the homelab backends actually use.
 */
export interface ParamSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
  enum?: ReadonlyArray<string | number>;
  range?: readonly [number, number];
  regex?: RegExp;
  /** Friendly format hint used by validators (`url`, `path`, etc.). */
  format?:
    | 'identifier'
    | 'shell-safe-arg'
    | 'url'
    | 'path'
    | 'absolute-path';
  /** For arrays. */
  items?: ParamSchema | { type: 'string'; regex?: RegExp } | { type: 'object'; properties: Record<string, ParamSchema> };
  /** For objects with free-form keys (e.g. env-var maps). */
  additionalProperties?: ParamSchema;
  /** For typed object properties. */
  properties?: Record<string, ParamSchema>;
}

export type DeployParameters = Record<string, unknown>;

export interface BuildContext {
  /** ULID/UUID identifying the request that triggered the build. */
  requestId: string;
  /** Target environment label (e.g. "prod", "staging"). */
  envName: string;
  /** Repo path on the daemon host (used to resolve relative file paths). */
  repoPath: string;
  /** Git commit SHA being deployed. */
  commitSha: string;
  /** Per-deploy parameters; backend validates against its PARAM_SCHEMA. */
  params: DeployParameters;
}

export interface BuildArtifact {
  type: string;
  /** URL-style location used for downstream lookups. */
  location: string;
  /** Hex-encoded checksum (sha256). */
  checksum: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export interface DeploymentRecordPayload {
  /** ULID for this deployment. */
  id: string;
  /** Backend `metadata.name`. */
  backendName: string;
  /** Inventory entry type being targeted (e.g. `homelab-proxmox`). */
  target: string;
  /** Environment label. */
  envName: string;
  /** Build artifact location. */
  artifactLocation: string;
  /** Backend-specific structured details captured at deploy time. */
  details: Record<string, unknown>;
  /** ISO-8601 timestamp of the successful deploy. */
  deployedAt: string;
}

/**
 * HMAC-signed deployment record. The payload is canonicalised (RFC 8785-style)
 * and signed with `HOMELAB_HMAC_SECRET` via `signDeploymentRecord`.
 */
export interface DeploymentRecord {
  payload: DeploymentRecordPayload;
  hmac: string;
}

export interface HealthCheckProbe {
  timestamp: string;
  outcome: 'success' | 'failure';
  latencyMs: number;
  /** Optional probe-specific reason (HTTP status, stderr, etc.). */
  detail?: string;
}

export interface HealthStatus {
  healthy: boolean;
  /** Last 5 probe entries (most recent last). */
  checks: HealthCheckProbe[];
  /** Populated when `healthy === false`. */
  unhealthyReason?: string;
}

export interface RollbackResult {
  success: boolean;
  /** Populated when rollback succeeds; absent on failure. */
  restoredArtifactId?: string;
  /** Empty on success; populated with diagnostic strings on failure. */
  errors: string[];
}

/**
 * The interface every homelab backend implements. Mirrors the autonomous-dev
 * `DeploymentBackend` contract: build → deploy → healthCheck → rollback.
 */
export interface DeploymentBackend {
  readonly metadata: BackendMetadata;
  build(ctx: BuildContext): Promise<BuildArtifact>;
  deploy(
    artifact: BuildArtifact,
    env: string,
    params: DeployParameters,
  ): Promise<DeploymentRecord>;
  healthCheck(record: DeploymentRecord): Promise<HealthStatus>;
  rollback(record: DeploymentRecord): Promise<RollbackResult>;
}
