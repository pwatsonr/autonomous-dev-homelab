/**
 * Audit log event types and entry shape. SPEC-001-3-02.
 *
 * `AuditEntry` is the canonical on-disk record format. Each line in
 * `<homelab-data>/audit.log` is `JSON.stringify(entry) + '\n'`.
 *
 * The HMAC field is computed AFTER the rest of the entry is built, by
 * canonicalizing the entry-minus-hmac and hashing
 * `prev_hmac || canonical_json(entry_minus_hmac)` with HMAC-SHA256
 * keyed by the writer's audit key.
 */

export type AuditEventType =
  | 'discovery_started'
  | 'discovery_completed'
  | 'consent_granted'
  | 'consent_revoked'
  | 'ca_initialized'
  | 'ca_rotated'
  | 'cert_signed'
  | 'cert_revoked'
  | 'connection_opened'
  | 'connection_failed'
  | 'connection_closed'
  | 'command_executed'
  | 'audit_key_rotated';

export interface AuditEntry {
  /** Monotonic counter starting at 1. */
  seq: number;
  /** ISO-8601 timestamp with millisecond precision. */
  timestamp: string;
  /** OS user that initiated the action (process.env.USER by default). */
  actor: string;
  /** Inventory platform id when relevant; null otherwise. */
  platform: string | null;
  event: AuditEventType;
  /** Event-specific structured payload. */
  payload: Record<string, unknown>;
  /** hex(HMAC-SHA256(key, prev_hmac || canonical_json(entry_minus_hmac))) */
  hmac: string;
}

export interface AppendOpts {
  platform?: string | null;
  actor?: string;
}

/** Thrown when an audit append fails (disk full, permission denied, etc.). */
export class AuditWriteError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AuditWriteError';
  }
}

/** Thrown when the audit-key file is present but cannot be parsed. */
export class InvalidAuditKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAuditKeyError';
  }
}

/** Thrown when the audit-log tail-recovery encounters a truncated last line. */
export class CorruptAuditLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptAuditLogError';
  }
}

/** All zeroes hex string used as the genesis prev_hmac. */
export const GENESIS_PREV_HMAC = '0'.repeat(64);
