/**
 * Per-platform default freshness rules. SPEC-002-2-04.
 *
 * Operators may override per-platform via `verifyBackup({freshnessOverrides})`.
 * When the platform is not in this map and no override applies, the
 * default `max_age_seconds` from the orchestrator (24h) is used.
 */

export const DEFAULT_FRESHNESS: Readonly<Record<string, number>> = Object.freeze({
  proxmox: 86_400, // 24h
  truenas: 86_400, // 24h (zfs)
  freenas: 86_400,
  docker: 7 * 86_400, // 7d (image rebuilds tolerated)
  kubernetes: 86_400,
  unraid: 86_400,
  unifi: 7 * 86_400,
});

/** Universal default when neither overrides nor DEFAULT_FRESHNESS apply. */
export const FALLBACK_MAX_AGE_SECONDS = 86_400;
