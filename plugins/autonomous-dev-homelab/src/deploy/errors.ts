/**
 * `DeployError` per SPEC-002-3-01. Mirrors the autonomous-dev SPEC-023-1-01
 * error code shape locally so the homelab backends do not depend on a
 * cross-repo import.
 */

export type DeployErrorCode =
  | 'INVALID_PARAMS'
  | 'BUILD_FAILED'
  | 'DEPLOY_FAILED'
  | 'HEALTH_FAILED'
  | 'ROLLBACK_FAILED'
  | 'IMAGE_PULL_FAILED'
  | 'CREDENTIAL_INVALID';

export interface DeployErrorOptions {
  code: DeployErrorCode;
  message: string;
  /** Hint to callers: should the operation be retried? */
  retriable?: boolean;
  /** Optional structured context. */
  details?: Record<string, unknown>;
}

export class DeployError extends Error {
  readonly code: DeployErrorCode;
  readonly retriable: boolean;
  readonly details: Record<string, unknown>;

  constructor(opts: DeployErrorOptions) {
    super(opts.message);
    this.name = 'DeployError';
    this.code = opts.code;
    this.retriable = opts.retriable === true;
    this.details = opts.details ?? {};
  }
}
