/**
 * Deploy contract — published type surface (#666).
 *
 * This module is the canonical shared vocabulary for the stateful-target
 * contract. Both the core orchestrator and the homelab plugin consume types
 * from here WITHOUT cross-repo imports (pattern from credential-proxy-types.ts).
 *
 * Three additions over the existing types:
 *   1. `stateful` capability flag — declared in `ResolvedContractTarget.capabilities`.
 *   2. `BackupClass` enum — per-target data-protection classification.
 *   3. `requiresVerifiedBackup` precondition — per-deploy request field.
 *
 * Governing invariant #674: capabilities/roles/tags ONLY — never instance ids
 * or hard-coded service/node names.
 */

// ---------------------------------------------------------------------------
// BackupClass
// ---------------------------------------------------------------------------

/**
 * Per-target data-protection classification. Governs how the orchestrator
 * surfaces backup requirements and what the homelab plugin must verify.
 *
 * - `none`         — target carries no persistent state; no backup required.
 * - `snapshot`     — target owns persistent data; a filesystem/volume snapshot
 *                    is expected before a deploy is allowed.
 * - `orchestrated` — target's backup is managed by an external orchestrator
 *                    (e.g. pg_basebackup, mysqldump script, restic job); the
 *                    deploy path must verify that the orchestrator ran
 *                    successfully within the freshness window.
 *
 * Invariant #674: these are CLASSIFICATIONS, not instance names.
 */
export type BackupClass = "none" | "snapshot" | "orchestrated";

/** Typed enum object so callers can use `BACKUP_CLASS.snapshot` instead of string literals. */
export const BACKUP_CLASS: Readonly<Record<BackupClass, BackupClass>> = {
  none: "none",
  snapshot: "snapshot",
  orchestrated: "orchestrated",
} as const;

// ---------------------------------------------------------------------------
// TargetLocation
// ---------------------------------------------------------------------------

/** Physical or logical deployment destination. Determines which dispatch path runs. */
export type TargetLocation = "cloud" | "homelab";

// ---------------------------------------------------------------------------
// ResolvedContractTarget
// ---------------------------------------------------------------------------

/**
 * A fully-resolved deploy target carrying all information the orchestrator
 * and selector need to make routing and precondition decisions.
 *
 * Capability flags and tags are used for ALL branching logic.
 * No instance identifiers may appear in `capabilities` or `tags`.
 * Invariant #674.
 */
export interface ResolvedContractTarget {
  /**
   * Opaque identifier for this target (may be used for logging/records only;
   * never for behavioral branching).
   */
  id: string;

  /** Determines the dispatch path: cloud (GCP/AWS/Azure/K8s) vs homelab delegate. */
  location: TargetLocation;

  /**
   * Capability flags declared by this target. Well-known values:
   *   - `'stateful'` — target owns persistent state; backup precondition applies.
   * Invariant #674: flags describe CAPABILITIES, not instance names or node ids.
   */
  capabilities: string[];

  /**
   * Data-protection classification for this target.
   * Absent on legacy records; treat missing as `'none'`.
   */
  backup_class: BackupClass;

  /**
   * Free-form role/attribute tags used for routing and policy decisions.
   * Example: `['role:database', 'tier:prod']`.
   * Invariant #674: never hard-coded service instance ids.
   */
  tags: string[];
}

// ---------------------------------------------------------------------------
// DeployContractRequest
// ---------------------------------------------------------------------------

/**
 * A deploy request enriched with the stateful contract fields (#666).
 *
 * Callers set `requiresVerifiedBackup: true` when the spec says the target
 * must have a recent verified backup before the deploy proceeds.
 * The core orchestrator reads this flag; enforcement of the ACTUAL backup
 * check is DELEGATED to the plugin for homelab targets.
 */
export interface DeployContractRequest {
  /** ULID/UUID for this deploy request. */
  requestId: string;

  /** Environment label (e.g. `'prod'`, `'staging'`). */
  envName: string;

  /** Git commit SHA being deployed. */
  commitSha: string;

  /** Resolved target (from the target resolver). */
  target: ResolvedContractTarget;

  /**
   * When `true`, the orchestrator MUST verify that a recent backup exists
   * (via `verifiedBackupRef` or `backupOverride`) before dispatching.
   * Core checks the precondition flag; it owns no backup-engine logic.
   */
  requiresVerifiedBackup: boolean;

  /**
   * Reference to a verified backup manifest (e.g. a checksum or manifest id).
   * Present when the backup gate has already been satisfied upstream.
   * When set, the precondition is considered satisfied.
   */
  verifiedBackupRef?: string;

  /**
   * When `true`, the backup precondition is explicitly waived by an operator.
   * This is an ADMIN-LEVEL BYPASS that must be explicitly supplied — it is
   * NEVER silently defaulted to `true`.
   */
  backupOverride: boolean;
}

// ---------------------------------------------------------------------------
// DeployContract — root envelope for contract schema versioning
// ---------------------------------------------------------------------------

/**
 * Root contract envelope. Carries schema version + provenance for audit.
 * Consumed by tooling that needs to detect contract format changes.
 */
export interface DeployContract {
  /** Monotonic integer bumped on breaking changes to this contract. */
  schemaVersion: number;
  /** ISO-8601 timestamp when this contract was evaluated. */
  issuedAt: string;
  /** Originating request id. */
  requestId: string;
}

// ---------------------------------------------------------------------------
// StatefulPreconditionResult
// ---------------------------------------------------------------------------

/**
 * Result of evaluating the stateful backup precondition for a deploy request.
 */
export interface StatefulPreconditionResult {
  /** `true` when the deploy may proceed; `false` when it must be blocked. */
  allowed: boolean;
  /** Human-readable explanation when `allowed === false`. */
  reason?: string;
  /** `true` when `backupOverride` was applied (audit trail). */
  overrideApplied?: boolean;
}

// ---------------------------------------------------------------------------
// evaluateStatefulPrecondition — pure logic, no I/O
// ---------------------------------------------------------------------------

/**
 * Evaluates the stateful backup precondition for a deploy request.
 *
 * Rules (in order):
 *  1. If the target does NOT carry the `'stateful'` capability → ALLOW
 *     (no backup requirement regardless of `requiresVerifiedBackup`).
 *  2. If `requiresVerifiedBackup === false` → ALLOW.
 *  3. If `backupOverride === true` → ALLOW (admin bypass; sets `overrideApplied`).
 *  4. If `verifiedBackupRef` is set and non-empty → ALLOW.
 *  5. Otherwise → BLOCK with a descriptive reason.
 *
 * This function owns NO backup-engine logic. It only inspects the request
 * fields. Actual backup verification is delegated to the plugin (homelab) or
 * the cloud backend's pre-deploy hook.
 *
 * @param request - The deploy contract request to evaluate.
 * @returns A `StatefulPreconditionResult` indicating whether the deploy may proceed.
 */
export function evaluateStatefulPrecondition(
  request: DeployContractRequest,
): StatefulPreconditionResult {
  const isStateful = request.target.capabilities.includes("stateful");

  // Rule 1: non-stateful target — always allow.
  if (!isStateful) {
    return { allowed: true };
  }

  // Rule 2: caller explicitly declared no backup requirement.
  if (!request.requiresVerifiedBackup) {
    return { allowed: true };
  }

  // Rule 3: explicit admin bypass.
  if (request.backupOverride) {
    return { allowed: true, overrideApplied: true };
  }

  // Rule 4: backup already verified upstream.
  if (
    typeof request.verifiedBackupRef === "string" &&
    request.verifiedBackupRef.trim() !== ""
  ) {
    return { allowed: true };
  }

  // Rule 5: blocked — precondition not satisfied.
  const cls = request.target.backup_class;
  return {
    allowed: false,
    reason:
      `Stateful deploy blocked: target '${request.target.id}' requires a verified backup ` +
      `(backup_class: ${cls}) but no verifiedBackupRef was supplied and backupOverride is false. ` +
      `Set verifiedBackupRef to the manifest id of a recent backup, or set backupOverride=true ` +
      `for an explicit admin bypass.`,
  };
}
