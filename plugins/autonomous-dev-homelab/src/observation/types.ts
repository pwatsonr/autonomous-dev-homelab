/**
 * Core types for the homelab observation layer. Implements
 * SPEC-002-1-01 §"`types.ts` — Core types".
 *
 * Defines:
 *   - `Severity` (P0/P1/P2)
 *   - `RequestType` (bug/infra/hotfix) — matches autonomous-dev intake
 *   - `Destructiveness` — TDD-002 §8 ladder categories
 *   - `FaultPattern` — closed union of every detection pattern the
 *     plugin understands. Extending the catalog requires adding to BOTH
 *     this union and `FAULT_CATALOG` (and the JSON schema enum).
 *   - `Observation` — the on-disk + on-wire record produced by every
 *     probe in SPEC-002-1-02 / SPEC-002-1-03 and persisted by the
 *     collector in SPEC-002-1-04.
 *   - `Probe` — interface every probe in SPEC-002-1-02 / SPEC-002-1-03
 *     implements; consumed by the collector.
 */

export type Severity = 'P0' | 'P1' | 'P2';

export type RequestType = 'bug' | 'infra' | 'hotfix';

export type Destructiveness =
  | 'read-only'
  | 'reversible'
  | 'persistent-modifying'
  | 'data-affecting'
  | 'architectural';

/**
 * Closed union of fault patterns the homelab plugin can detect.
 * Source of truth: TDD-002 §5 (table). Extending the catalog requires
 * adding to this union, `FAULT_CATALOG`, AND the JSON schema enum in
 * `schemas/observation-v1.json`.
 */
export type FaultPattern =
  | 'crash_loop'
  | 'oom_kill'
  | 'disk_io_error'
  | 'zfs_pool_degraded'
  | 'unifi_ap_offline'
  | 'cert_expiry_imminent'
  | 'backup_overdue'
  | 'service_5xx'
  | 'daemon_heartbeat_stale'
  /** Inventory drift (issue #31): entity absent from the latest refresh sweep. */
  | 'entity_gone'
  /** Inventory drift (issue #31): service running replicas below desired count. */
  | 'replica_mismatch'
  /** Inventory drift (issue #31): entity image attribute changed between sweeps. */
  | 'image_changed'
  /**
   * Prometheus/Alertmanager firing alert (issue #37, invariant #62).
   * Generic pattern: maps ANY firing alert to an observation. Alert name +
   * labels are carried in `details`. Severity derives from the `severity`
   * label (critical→P0, warning→P1, else P2). Resource derives from the
   * first non-empty label in priority order: instance, service, job, pod.
   */
  | 'prometheus_alert'
  /** Datastore health (issue #43): datastore unreachable or liveness probe failed. */
  | 'datastore_unhealthy'
  /** Datastore health (issue #43): replication lag exceeds threshold or replica absent. */
  | 'replication_lag'
  /** Datastore health (issue #43): connection count approaching configured maximum. */
  | 'datastore_near_capacity'
  /** Datastore health (issue #43): datastore disk usage approaching configured limit. */
  | 'datastore_disk_pressure';

export interface Observation {
  /** UUID v4. */
  id: string;
  /** Platform identifier from inventory (PLAN-001-1), e.g. "k3s-01". */
  platform: string;
  /** Pattern key from FAULT_CATALOG. */
  pattern: FaultPattern;
  /** Resource the pattern applies to, e.g. "Pod/web-7c". Used in dedup key. */
  resource: string;
  severity: Severity;
  /** ISO-8601 timestamp. */
  discovered_at: string;
  /** Probe-specific structured payload (free-form). */
  details?: Record<string, unknown>;
  /** Computed `<platform>:<pattern>:<resource>` for dedup lookups. */
  dedup_key?: string;
}

/**
 * Common interface every probe in SPEC-002-1-02 / SPEC-002-1-03 must
 * implement. The collector (SPEC-002-1-04) treats probes uniformly via
 * this interface and dispatches them per their declared `cadence`.
 */
export interface Probe {
  /** Probe identifier, e.g. "k8s", "docker". */
  readonly id: string;
  /** Inventory platform id this probe targets. */
  readonly platformId: string;
  /** Cadence bucket; collector translates to interval ms. */
  readonly cadence: 'fast' | 'medium' | 'slow' | 'daily';
  scan(): Promise<Observation[]>;
}
