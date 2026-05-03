/**
 * Shared safety types per SPEC-002-2-01.
 *
 * `Action`, `OperatorConfig`, `ApprovalResult`, `GateContext`, and
 * `SafetyAuditEvent` form the contract between the gate, the validator,
 * and downstream callers (migration orchestrator, deploy backends).
 */

import type { Destructiveness, TrustLevel } from './destructiveness.js';

/**
 * A single action passed through `gateApproval`. ULID id, classified
 * destructiveness, and a human-readable description for the operator
 * approval prompt. `dryRunReport` is REQUIRED for `architectural`; it is
 * the artifact the operator reviews during the 24h delay.
 */
export interface Action {
  /** ULID. */
  id: string;
  destructiveness: Destructiveness;
  target: { platform: string; resource: string };
  /** Human-readable summary surfaced in approval prompts. */
  description: string;
  /** Required for `architectural`; optional otherwise. */
  dryRunReport?: string;
  /** Agent or operator identifier requesting the action. */
  requestedBy: string;
  /** ISO 8601 timestamp. */
  initiatedAt: string;
}

/**
 * Operator config consumed at daemon startup. The validator (`validateOperatorConfig`)
 * rejects any below-floor entry. Optional fields fall back to defaults documented
 * in SPEC-002-2-02 (typed-CONFIRM TTL = 60s, data-dir resolution chain).
 */
export interface OperatorConfig {
  /** REQUIRED: trust-level mapping per destructiveness category. Validated against FLOOR. */
  auto_approval: Record<Destructiveness, TrustLevel>;
  /** Default 60. Validated upstream. */
  typed_confirm_ttl_seconds?: number;
  /** Default `<homelab-data>/pending-actions/`. */
  delay_state_dir?: string;
  /** Env-var name; default 'HOMELAB_HMAC_SECRET'. */
  hmac_secret_env?: string;
}

/**
 * Discriminated union: caller checks `result.approved` to narrow.
 */
export type ApprovalResult =
  | { approved: true; actionId: string; approvedAt: string; approvedBy: string }
  | { approved: false; actionId: string; reason: string };

/**
 * Per-invocation context. `audit` and `isAdmin` are injected so the gate
 * can be unit-tested without booting the audit writer or the auth
 * middleware. `flags` carries optional per-call switches; `skipBackupCheck`
 * is an admin-only escape hatch (SPEC-002-2-04 Task 10).
 */
export interface GateContext {
  config: OperatorConfig;
  /** Resolves to true iff the requesting operator has admin role. */
  isAdmin: () => boolean;
  /** Audit-event sink. PLAN-001-3 wraps a real `AuditWriter`. */
  audit: (event: SafetyAuditEvent) => Promise<void>;
  /** Optional per-call flags; honored by gate paths that support them. */
  flags?: { skipBackupCheck?: boolean };
}

/**
 * Audit-event shape emitted by the gate. The corresponding `AuditWriter`
 * event-type in PLAN-001-3 may use a slightly different schema; the
 * gate's `ctx.audit` adapter is responsible for translating.
 */
export interface SafetyAuditEvent {
  type: 'gate.allowed' | 'gate.denied' | 'gate.bypass' | 'config.rejected';
  action_id?: string;
  reason: string;
  /** ISO 8601. */
  occurred_at: string;
}
