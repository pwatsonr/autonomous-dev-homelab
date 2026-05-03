/**
 * Backup orchestration types per SPEC-002-2-04 (TDD-002 §11).
 *
 * The manifest file lives at `<homelab-data>/backup-manifest.json` and is
 * a single JSON document with an `entries` array. Each entry is HMAC-signed
 * inline (the entry's own `hmac` field signs the canonical entry minus
 * its own hmac).
 */

export interface BackupManifestEntry {
  platform: string;
  /** e.g., 'pve-backup' | 'zfs-snapshot' | 'docker-image'. Free-form by design. */
  backup_type: string;
  /** ISO 8601. */
  taken_at: string;
  /** Local path or remote URL. */
  location: string;
  size_bytes: number;
  /** HMAC-SHA256 over the canonical payload (excluding `hmac` itself). Hex. */
  hmac: string;
}

export interface FreshnessRule {
  platform: string;
  max_age_seconds: number;
}

export interface BackupVerificationResult {
  ok: true;
  entry: BackupManifestEntry;
}
