/**
 * Canonical backup-manifest types. Issues #46, #45, #47.
 *
 * ONE versioned schema (v2) used by:
 *   - `verifyBackup()` (orchestrator.ts)
 *   - `BackupOverdueProbe` (observation/probes/backup-overdue.ts)
 *   - backup execution engine (engine.ts)
 *   - restore engine (restore.ts)
 *
 * The manifest file lives at `<homelab-data>/backup-manifest.json`.
 *
 * HMAC-signing: each entry carries an inline `hmac` field that signs
 * the canonical JSON of the entry (minus the `hmac` field itself) with
 * HMAC-SHA256 using the `HOMELAB_HMAC_SECRET` env var.
 *
 * Back-compat: `convertLegacyManifest` accepts both the v1-verifier shape
 * (`{entries: [...]}`) and the v1-overdue-probe shape (`{backups: [...]}`)
 * and upgrades them to v2.
 */

// ---------------------------------------------------------------------------
// Canonical entry (v2)
// ---------------------------------------------------------------------------

/**
 * A single backup artifact recorded in the manifest (schema v2).
 *
 * Fields unified from the two conflicting v1 shapes:
 *   v1-verifier:    `platform`, `backup_type`, `taken_at`, `location`, `size_bytes`, `hmac`
 *   v1-overdue:     `target_id` (was `id`), `max_age_seconds` (was `max_age_hours`)
 *
 * Added by the execution engine: `checksum`, `verified`.
 */
export interface BackupManifestEntry {
  /** Schema version — always 2 for entries written by this code. */
  schema_version: 2;
  /**
   * Platform type (e.g. "proxmox", "docker", "postgres").
   * Used by `verifyBackup()` to filter candidates.
   */
  platform: string;
  /**
   * Logical target identifier within the platform
   * (e.g. "pve-backup", "zfs-snapshot", "restic-pg").
   * Used by the overdue probe as the resource label.
   */
  target_id: string;
  /** Free-form driver/backup type string (e.g. "pg_dump", "rsync"). */
  backup_type: string;
  /** ISO 8601 UTC timestamp when the backup was taken. */
  taken_at: string;
  /** Local path or remote URL to the backup artifact. */
  location: string;
  /** Size of the artifact in bytes. */
  size_bytes: number;
  /**
   * Maximum age in seconds before this entry is considered stale.
   * Defaults to 86400 (24h) when absent.
   */
  max_age_seconds: number;
  /**
   * SHA-256 hex checksum of the backup artifact.
   * Empty string when the driver did not compute one (back-compat).
   */
  checksum: string;
  /**
   * True when this entry has been verified by a successful restore dry-run.
   * Written by the restore engine; set to false by the execution engine.
   */
  verified: boolean;
  /**
   * HMAC-SHA256 over `canonicalJson(entry_minus_hmac_field)`. Hex.
   * Set by `signManifestEntry`; empty string in a freshly-constructed object.
   */
  hmac: string;
}

// ---------------------------------------------------------------------------
// Legacy shapes (read by the back-compat converter)
// ---------------------------------------------------------------------------

/** V1 shape from the verifier (orchestrator.ts pre-#46). */
export interface LegacyVerifierEntry {
  platform: string;
  backup_type: string;
  taken_at: string;
  location: string;
  size_bytes: number;
  hmac: string;
}

/** V1 shape from the overdue probe (backup-overdue.ts pre-#46). */
export interface LegacyOverdueEntry {
  id: string;
  last_run: string;
  max_age_hours: number;
}

// ---------------------------------------------------------------------------
// Manifest file shapes
// ---------------------------------------------------------------------------

/** V2 canonical manifest file shape. */
export interface BackupManifestFile {
  schema_version: 2;
  entries: BackupManifestEntry[];
}

// ---------------------------------------------------------------------------
// Back-compat converter (#46)
// ---------------------------------------------------------------------------

/**
 * Converts any legacy manifest shape (v1-verifier, v1-overdue, or mixed)
 * to a v2 `BackupManifestFile`. HMACs on legacy v1-verifier entries are
 * carried through as-is (they may still verify against the old signing
 * payload; the caller is responsible for re-signing if needed).
 *
 * Handles three cases:
 *   1. Already v2 (`schema_version === 2`) — returned as-is.
 *   2. V1-verifier shape (`entries[]` with `platform` field) — promoted.
 *   3. V1-overdue-probe shape (`backups[]` with `id`/`last_run` fields) — promoted.
 *
 * @param raw - Parsed JSON value from disk (unknown shape).
 * @returns Canonical v2 manifest file.
 */
export function convertLegacyManifest(raw: unknown): BackupManifestFile {
  if (raw === null || typeof raw !== 'object') {
    return { schema_version: 2, entries: [] };
  }
  const obj = raw as Record<string, unknown>;

  // Already v2.
  if (obj['schema_version'] === 2 && Array.isArray(obj['entries'])) {
    return raw as BackupManifestFile;
  }

  const result: BackupManifestEntry[] = [];

  // V1-verifier shape: `entries[]` with `platform` field.
  if (Array.isArray(obj['entries'])) {
    for (const e of obj['entries'] as LegacyVerifierEntry[]) {
      if (typeof e.platform !== 'string') continue;
      result.push({
        schema_version: 2,
        platform: e.platform,
        target_id: e.backup_type ?? e.platform,
        backup_type: e.backup_type ?? '',
        taken_at: e.taken_at ?? new Date().toISOString(),
        location: e.location ?? '',
        size_bytes: typeof e.size_bytes === 'number' ? e.size_bytes : 0,
        max_age_seconds: 86_400,
        checksum: '',
        verified: false,
        hmac: e.hmac ?? '',
      });
    }
  }

  // V1-overdue-probe shape: `backups[]` with `id`/`last_run` fields.
  if (Array.isArray(obj['backups'])) {
    for (const b of obj['backups'] as LegacyOverdueEntry[]) {
      if (typeof b.id !== 'string') continue;
      result.push({
        schema_version: 2,
        platform: 'unknown',
        target_id: b.id,
        backup_type: 'unknown',
        taken_at: b.last_run ?? new Date().toISOString(),
        location: '',
        size_bytes: 0,
        max_age_seconds:
          typeof b.max_age_hours === 'number' ? b.max_age_hours * 3600 : 86_400,
        checksum: '',
        verified: false,
        hmac: '',
      });
    }
  }

  return { schema_version: 2, entries: result };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Returned by `verifyBackup` on success. */
export interface BackupVerificationResult {
  ok: true;
  entry: BackupManifestEntry;
}

// ---------------------------------------------------------------------------
// Legacy type alias (kept for backward compat with freshness-rules.ts)
// ---------------------------------------------------------------------------

export interface FreshnessRule {
  platform: string;
  max_age_seconds: number;
}
