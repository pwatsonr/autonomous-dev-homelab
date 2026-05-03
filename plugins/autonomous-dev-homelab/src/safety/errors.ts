/**
 * Safety error classes per SPEC-002-2-01.
 *
 * Every error carries a stable `code` for machine-readable handling
 * (CLI exit codes, audit log filtering). `code` is a literal string union
 * that downstream code may switch on.
 */

/** Thrown by `validateOperatorConfig` when an entry is below FLOOR. */
export class ConfigurationError extends Error {
  readonly code = 'CONFIG_BELOW_FLOOR' as const;
  readonly details: { destructiveness: string; configured: string; floor: string };

  constructor(details: { destructiveness: string; configured: string; floor: string }) {
    super(
      `Operator config sets auto_approval.${details.destructiveness}=${details.configured}, ` +
        `but the destructiveness floor requires ${details.floor} or stricter (TDD §8).`,
    );
    this.name = 'ConfigurationError';
    this.details = details;
  }
}

/** Thrown by `gateApproval` when the operator denies/times-out a typed-CONFIRM. */
export class ApprovalDeniedError extends Error {
  readonly code = 'APPROVAL_DENIED' as const;
  readonly actionId: string;

  constructor(actionId: string, reason: string) {
    super(`Action ${actionId} denied: ${reason}`);
    this.name = 'ApprovalDeniedError';
    this.actionId = actionId;
  }
}

/** Thrown by `verifyBackup` (and propagated through gate) when no fresh backup exists. */
export class BackupRequiredError extends Error {
  readonly code = 'BACKUP_REQUIRED' as const;
  readonly actionId: string;
  readonly target: string;

  constructor(actionId: string, target: string) {
    super(`Action ${actionId} requires a fresh backup of ${target}; none found in manifest.`);
    this.name = 'BackupRequiredError';
    this.actionId = actionId;
    this.target = target;
  }
}
