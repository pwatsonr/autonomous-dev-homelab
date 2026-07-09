/**
 * Typed fault-pattern catalog. Implements SPEC-002-1-01 §"`fault-catalog.ts`".
 *
 * Source of truth: TDD-002 §5 (the fault-pattern table). Each entry
 * maps a `FaultPattern` to its detection description, severity, default
 * `request_type` (consumed by the promoter in SPEC-002-1-04), and
 * destructiveness category (TDD-002 §8 ladder).
 *
 * Extension policy: future plans extending the catalog must add to BOTH
 * the `FaultPattern` union in `./types.ts` AND `FAULT_CATALOG` AND the
 * JSON schema `enum` in `schemas/observation-v1.json`. The
 * `Readonly<Record<FaultPattern, ...>>` type forces the compiler to
 * flag any missing entry the moment a new pattern is added.
 */

import type {
  Destructiveness,
  FaultPattern,
  RequestType,
  Severity,
} from './types.js';

export interface FaultCatalogEntry {
  pattern: FaultPattern;
  /** Human-readable detection description (matches TDD-002 §5 column "Detection"). */
  detection: string;
  severity: Severity;
  default_request_type: RequestType;
  destructiveness: Destructiveness;
}

/**
 * Catalog of fault patterns the homelab plugin knows how to detect.
 * Source of truth: TDD-002 §5. Extended by future plans (e.g. security,
 * capacity).
 */
export const FAULT_CATALOG: Readonly<Record<FaultPattern, FaultCatalogEntry>> =
  Object.freeze({
    crash_loop: {
      pattern: 'crash_loop',
      detection: 'k8s events / docker restart count',
      severity: 'P1',
      default_request_type: 'bug',
      destructiveness: 'reversible',
    },
    oom_kill: {
      pattern: 'oom_kill',
      detection: 'k8s events / docker stats / dmesg',
      severity: 'P1',
      default_request_type: 'bug',
      destructiveness: 'persistent-modifying',
    },
    disk_io_error: {
      pattern: 'disk_io_error',
      detection: 'SMART warnings / dmesg',
      severity: 'P0',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    zfs_pool_degraded: {
      pattern: 'zfs_pool_degraded',
      detection: 'zpool status non-ONLINE',
      severity: 'P0',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    unifi_ap_offline: {
      pattern: 'unifi_ap_offline',
      detection: 'UniFi events API',
      severity: 'P1',
      default_request_type: 'bug',
      destructiveness: 'reversible',
    },
    cert_expiry_imminent: {
      pattern: 'cert_expiry_imminent',
      detection: 'x509 issuer scan within 7d',
      severity: 'P2',
      default_request_type: 'hotfix',
      destructiveness: 'reversible',
    },
    backup_overdue: {
      pattern: 'backup_overdue',
      detection: 'manifest age check >24h',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    service_5xx: {
      pattern: 'service_5xx',
      detection: 'HTTP probe sustained 5xx >5min',
      severity: 'P1',
      default_request_type: 'bug',
      destructiveness: 'reversible',
    },
    daemon_heartbeat_stale: {
      pattern: 'daemon_heartbeat_stale',
      detection: 'autonomous-dev daemon heartbeat file stale',
      severity: 'P0',
      default_request_type: 'hotfix',
      destructiveness: 'reversible',
    },
    entity_gone: {
      pattern: 'entity_gone',
      detection: 'inventory refresh sweep: entity last_seen exceeds gone threshold',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    replica_mismatch: {
      pattern: 'replica_mismatch',
      detection: 'inventory refresh sweep: replicas_running < replicas_desired',
      severity: 'P1',
      default_request_type: 'bug',
      destructiveness: 'reversible',
    },
    image_changed: {
      pattern: 'image_changed',
      detection: 'inventory refresh sweep: entity image attribute differs from previous sweep',
      severity: 'P2',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    prometheus_alert: {
      pattern: 'prometheus_alert',
      detection:
        'Alertmanager/Prometheus firing alert: GET /api/v2/alerts?active=true or /api/v1/alerts',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    // Datastore health patterns (issue #43)
    datastore_unhealthy: {
      pattern: 'datastore_unhealthy',
      detection: 'datastore liveness probe: exec client ping/status returns error or non-zero exit',
      severity: 'P0',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    replication_lag: {
      pattern: 'replication_lag',
      detection: 'datastore replication probe: replica lag exceeds threshold or replication slot absent',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    datastore_near_capacity: {
      pattern: 'datastore_near_capacity',
      detection: 'datastore capacity probe: connection count or memory usage approaching configured maximum',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    datastore_disk_pressure: {
      pattern: 'datastore_disk_pressure',
      detection: 'datastore disk probe: data directory usage approaching configured limit',
      severity: 'P0',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    // Policy-drift pattern (issue #35, invariant #62)
    policy_drift: {
      pattern: 'policy_drift',
      detection:
        'policy-drift probe: live service/workload placement evaluated against generated homelab ' +
        'policy rules; violation emitted when placement contradicts a placement or affinity rule',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    // Capacity / fill-rate patterns (issue #44, invariant #62)
    capacity_warning: {
      pattern: 'capacity_warning',
      detection:
        'capacity probe: storage fill ratio exceeds warn threshold (default 80 %); emitted for any capacity-bearing entity (storage-array, storage-disk, share, datastore, pool)',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
    capacity_critical: {
      pattern: 'capacity_critical',
      detection:
        'capacity probe: storage fill ratio exceeds critical threshold (default 90 %); same entity kinds as capacity_warning',
      severity: 'P0',
      default_request_type: 'infra',
      destructiveness: 'data-affecting',
    },
    capacity_growth: {
      pattern: 'capacity_growth',
      detection:
        'capacity probe: fill-rate projection shows storage reaching 100 % within the configured growth window (default 7 days), even when below warn threshold',
      severity: 'P1',
      default_request_type: 'infra',
      destructiveness: 'reversible',
    },
  });

/** Type-guard: narrows a string to `FaultPattern` if it is a known key. */
export function isFaultPattern(value: string): value is FaultPattern {
  return Object.prototype.hasOwnProperty.call(FAULT_CATALOG, value);
}
