/**
 * Shared metric types for the homelab metrics layer (SPEC-002-3-03).
 *
 * Mirrors the canonical metric names + label sets surfaced in the
 * Grafana dashboard at `dashboards/homelab.json`. Names are STABLE
 * across plugin minor versions; changes require a major version bump.
 */

import type { Destructiveness } from '../safety/destructiveness.js';

export type ActionType = 'bug' | 'infra' | 'hotfix';

export type BypassReason =
  | 'config-below-floor'
  | 'wrong-confirm'
  | 'missing-admin';

export type MetricName =
  | 'homelab_mttr_seconds'
  | 'homelab_fp_rate'
  | 'homelab_gate_latency_seconds'
  | 'homelab_bypass_attempts_total';

export interface MetricEvent {
  name: MetricName;
  /** `histogram` for *_seconds, `gauge` for fp_rate, `counter` for *_total. */
  kind: 'histogram' | 'gauge' | 'counter';
  value: number;
  labels: Record<string, string>;
}

/**
 * Pluggable sink for emitted metrics. Production wiring uses the
 * autonomous-dev TDD-007 metrics-pipeline client; tests pass an
 * in-memory implementation that records events for assertion.
 */
export interface MetricSink {
  emit(event: MetricEvent): void;
}

/** Re-exported for emitter signatures. */
export type { Destructiveness };
