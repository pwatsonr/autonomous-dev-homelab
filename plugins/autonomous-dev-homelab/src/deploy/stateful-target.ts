/**
 * Stateful-target detection for the homelab deploy backends (issue #33).
 *
 * A deploy target is "stateful" when it owns persistent data that must be
 * preserved across redeploys and that, if lost, cannot be recovered without a
 * backup. The detection is GENERIC and attribute-driven — never name-driven —
 * to satisfy invariant #62.
 *
 * Detection criteria (either is sufficient):
 *
 *   1. **Role-based**: the deploy spec carries `attributes.role` (or the
 *      raw param `role`) equal to one of the stateful roles defined in
 *      `STATEFUL_ROLES` (`"database"` or `"cache"`). This mirrors the roles
 *      assigned by the `RoleClassifier` in `src/discovery/role-catalog.ts`.
 *
 *   2. **Volume-based**: the deploy spec declares `named_volumes` (a
 *      non-empty string array) or `storage_mounts` (a non-empty array whose
 *      entries have `host_path`). Named volumes in Docker Swarm compose files
 *      and persistent Unraid share mounts both qualify.
 *
 * Invariant #62 compliance: no hard-coded service instance names appear here.
 * The check is purely on observable signals carried in the deploy parameters
 * (role attribute, declared volumes, declared mounts).
 */

import { KNOWN_ROLES } from '../discovery/role-catalog.js';

// ---------------------------------------------------------------------------
// STATEFUL_ROLES — the set of role strings that imply stateful ownership.
// ---------------------------------------------------------------------------

/**
 * Role strings (from `KNOWN_ROLES`) that imply the service owns persistent
 * state. Extend this set by appending entries; no other code changes are
 * needed (invariant #62).
 *
 * "database" — relational/document DB (Postgres, MySQL, Mongo …)
 * "cache"    — in-memory store with persistence (Redis AOF/RDB, Valkey …)
 */
export const STATEFUL_ROLES: ReadonlySet<string> = new Set<string>([
  KNOWN_ROLES.database,
  KNOWN_ROLES.cache,
]);

// ---------------------------------------------------------------------------
// StatefulDeploySpec
// ---------------------------------------------------------------------------

/**
 * The subset of deploy parameters that `isStatefulTarget` inspects.
 *
 * Both backends pass their full validated params; only the fields below are
 * examined. Unknown/extra fields are silently ignored.
 */
export interface StatefulDeploySpec {
  /**
   * Role string assigned to this service via the discovery role catalog.
   * When present and in `STATEFUL_ROLES`, the target is stateful.
   * Invariant #62: this is an OBSERVABLE ATTRIBUTE, not an instance name.
   */
  role?: string;

  /**
   * Named Docker volumes declared for this service (Docker Swarm backend).
   * A non-empty array means the service owns at least one named volume.
   */
  named_volumes?: string[];

  /**
   * Persistent storage mounts (Unraid backend). Each entry with a non-empty
   * `host_path` implies a persistent bind-mount that must be preserved.
   */
  storage_mounts?: Array<{ host_path?: string; container_path?: string }>;
}

// ---------------------------------------------------------------------------
// StatefulDeployConfig — configurable thresholds
// ---------------------------------------------------------------------------

/**
 * Runtime-configurable behavior for stateful-aware deploys.
 *
 * Safe defaults are `require_backup: true` and `backup_freshness_seconds`
 * taken from the per-platform freshness rules in
 * `src/backup/freshness-rules.ts`. Operators may override at backend
 * construction time; the toggle is NEVER forced off silently.
 */
export interface StatefulDeployConfig {
  /**
   * When `true` (default), a stateful deploy REQUIRES a fresh verified
   * backup via `verifyBackup` before proceeding. Set to `false` only for
   * admin-level bypass (must be explicitly passed — never defaulted off).
   */
  requireBackup: boolean;

  /**
   * Optional per-call freshness override (seconds). When supplied, overrides
   * the per-platform default in `DEFAULT_FRESHNESS`. When absent, the
   * orchestrator's existing resolution chain applies.
   */
  backupFreshnessOverrides?: Record<string, number>;
}

/** Safe production default: backup required, no freshness override. */
export const DEFAULT_STATEFUL_CONFIG: StatefulDeployConfig = Object.freeze({
  requireBackup: true,
});

// ---------------------------------------------------------------------------
// isStatefulTarget
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the deploy spec describes a stateful target.
 *
 * The check is performed ENTIRELY on observable signals in `spec` —
 * no service-name matching, no regex on container names. This satisfies
 * invariant #62: a newly-discovered service with `role="database"` or
 * a compose service that declares a named volume will be detected
 * automatically without any code change.
 *
 * @param spec - Deploy parameters to inspect (role + volume declarations).
 * @param roles - Optional override of the stateful role set (for testing).
 * @returns `true` when the spec implies stateful ownership of persistent data.
 *
 * @example
 * // Role-based (from RoleClassifier):
 * isStatefulTarget({ role: 'database' })          // → true
 * isStatefulTarget({ role: 'cache' })             // → true
 * isStatefulTarget({ role: 'reverse-proxy' })     // → false
 *
 * @example
 * // Volume-based (Docker Swarm named volumes):
 * isStatefulTarget({ named_volumes: ['pg-data'] }) // → true
 * isStatefulTarget({ named_volumes: [] })          // → false
 *
 * @example
 * // Mount-based (Unraid storage mounts):
 * isStatefulTarget({ storage_mounts: [{ host_path: '/mnt/user/data', container_path: '/data' }] }) // → true
 * isStatefulTarget({ storage_mounts: [] })         // → false
 */
export function isStatefulTarget(
  spec: StatefulDeploySpec,
  roles: ReadonlySet<string> = STATEFUL_ROLES,
): boolean {
  // 1. Role-based: explicit role attribute from the discovery catalog.
  if (typeof spec.role === 'string' && spec.role !== '' && roles.has(spec.role)) {
    return true;
  }

  // 2. Volume-based: named Docker volumes declared in the spec.
  if (Array.isArray(spec.named_volumes) && spec.named_volumes.length > 0) {
    return true;
  }

  // 3. Mount-based: persistent Unraid storage mounts with a non-empty host_path.
  if (Array.isArray(spec.storage_mounts)) {
    const hasPersistentMount = spec.storage_mounts.some(
      (m) => typeof m.host_path === 'string' && m.host_path.trim() !== '',
    );
    if (hasPersistentMount) return true;
  }

  return false;
}
