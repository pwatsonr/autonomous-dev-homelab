/**
 * Migration types per SPEC-002-2-04 (TDD-002 §10).
 *
 * `Migration` is the operator-facing schema (mirrors the JSON schema at
 * `schemas/migration-v1.json`). `MigrationState` extends it with mutable
 * runtime fields persisted by the orchestrator after every phase
 * transition.
 */

/** Five fixed phases per TDD §10. Order is significant — orchestrator iterates left-to-right. */
export type MigrationPhaseName =
  | 'identify-resources'
  | 'plan-target'
  | 'dry-run'
  | 'approval-delay'
  | 'execute';

export interface MigrationPhase {
  name: MigrationPhaseName;
  status: 'pending' | 'in-progress' | 'complete' | 'failed' | 'cancelled';
  /** ISO 8601. Set when the orchestrator enters the phase. */
  started_at?: string;
  /** ISO 8601. Set when the phase completes successfully. */
  completed_at?: string;
  /** Phase-specific output (resource list, dry-run report text, ...). */
  output?: unknown;
  /** Set when the phase fails. */
  error?: { message: string; code?: string };
}

export interface Migration {
  /** ULID. */
  migration_id: string;
  /** e.g., "portainer". */
  source_platform: string;
  /** e.g., "k3s". */
  target_platform: string;
  /** ENFORCED: only valid value. Migrations are always architectural. */
  classification: 'architectural';
  description: string;
  /** Operator id. */
  initiated_by: string;
  /** ISO 8601. */
  initiated_at: string;
  /** Default 86_400 (24h). Minimum 3600 (1h) per JSON schema. */
  approval_delay_seconds: number;
  /** ENFORCED: only valid value. */
  requires_typed_confirm: true;
  /** Five entries, ordered identically to MigrationPhaseName. */
  phases: MigrationPhase[];
}

export interface MigrationState extends Migration {
  /** 0-based; references `phases[current_phase_index]`. */
  current_phase_index: number;
  overall_status: 'in-flight' | 'complete' | 'cancelled' | 'failed';
}
