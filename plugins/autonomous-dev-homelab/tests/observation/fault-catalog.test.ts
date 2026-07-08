/**
 * SPEC-002-1-01 — fault-catalog tests.
 * Verifies catalog completeness, frozen-ness, type-guard behaviour, and
 * row-for-row alignment with TDD-002 §5.
 */

import {
  FAULT_CATALOG,
  isFaultPattern,
  type FaultCatalogEntry,
} from '../../src/observation/fault-catalog';
import type { FaultPattern } from '../../src/observation/types';

const EXPECTED: ReadonlyArray<
  Pick<FaultCatalogEntry, 'pattern' | 'severity' | 'default_request_type' | 'destructiveness'>
> = [
  { pattern: 'crash_loop', severity: 'P1', default_request_type: 'bug', destructiveness: 'reversible' },
  { pattern: 'oom_kill', severity: 'P1', default_request_type: 'bug', destructiveness: 'persistent-modifying' },
  { pattern: 'disk_io_error', severity: 'P0', default_request_type: 'infra', destructiveness: 'data-affecting' },
  { pattern: 'zfs_pool_degraded', severity: 'P0', default_request_type: 'infra', destructiveness: 'data-affecting' },
  { pattern: 'unifi_ap_offline', severity: 'P1', default_request_type: 'bug', destructiveness: 'reversible' },
  { pattern: 'cert_expiry_imminent', severity: 'P2', default_request_type: 'hotfix', destructiveness: 'reversible' },
  { pattern: 'backup_overdue', severity: 'P1', default_request_type: 'infra', destructiveness: 'reversible' },
  { pattern: 'service_5xx', severity: 'P1', default_request_type: 'bug', destructiveness: 'reversible' },
  { pattern: 'daemon_heartbeat_stale', severity: 'P0', default_request_type: 'hotfix', destructiveness: 'reversible' },
  // Inventory drift patterns added by issue #31.
  { pattern: 'entity_gone', severity: 'P1', default_request_type: 'infra', destructiveness: 'reversible' },
  { pattern: 'replica_mismatch', severity: 'P1', default_request_type: 'bug', destructiveness: 'reversible' },
  { pattern: 'image_changed', severity: 'P2', default_request_type: 'infra', destructiveness: 'reversible' },
  // Prometheus/Alertmanager probe added by issue #37.
  { pattern: 'prometheus_alert', severity: 'P1', default_request_type: 'infra', destructiveness: 'reversible' },
  // Datastore health patterns added by issue #43.
  { pattern: 'datastore_unhealthy', severity: 'P0', default_request_type: 'infra', destructiveness: 'data-affecting' },
  { pattern: 'replication_lag', severity: 'P1', default_request_type: 'infra', destructiveness: 'data-affecting' },
  { pattern: 'datastore_near_capacity', severity: 'P1', default_request_type: 'infra', destructiveness: 'reversible' },
  { pattern: 'datastore_disk_pressure', severity: 'P0', default_request_type: 'infra', destructiveness: 'data-affecting' },
];

describe('FAULT_CATALOG', () => {
  test('contains exactly 17 entries (9 original + 3 inventory-drift from #31 + 1 prometheus_alert from #37 + 4 datastore health from #43)', () => {
    expect(Object.keys(FAULT_CATALOG)).toHaveLength(17);
  });

  test('is frozen and rejects mutation in strict mode', () => {
    expect(Object.isFrozen(FAULT_CATALOG)).toBe(true);
    // ts-jest compiles with strict + isolatedModules; test bodies run as
    // strict-mode CJS so mutating a frozen object throws TypeError.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (FAULT_CATALOG as any).oom_kill = { pattern: 'oom_kill' };
    }).toThrow(TypeError);
  });

  test.each(EXPECTED)(
    '$pattern → severity=$severity, request_type=$default_request_type, destructiveness=$destructiveness',
    ({ pattern, severity, default_request_type, destructiveness }) => {
      const entry = FAULT_CATALOG[pattern];
      expect(entry).toBeDefined();
      expect(entry.pattern).toBe(pattern);
      expect(entry.severity).toBe(severity);
      expect(entry.default_request_type).toBe(default_request_type);
      expect(entry.destructiveness).toBe(destructiveness);
      expect(typeof entry.detection).toBe('string');
      expect(entry.detection.length).toBeGreaterThan(0);
    },
  );

  test('every key matches the FaultPattern union (compile + runtime)', () => {
    // Compile-time: assigning each key to FaultPattern would fail tsc if
    // the union drifted. We exercise runtime narrowing here too.
    for (const key of Object.keys(FAULT_CATALOG) as FaultPattern[]) {
      expect(isFaultPattern(key)).toBe(true);
    }
  });
});

describe('isFaultPattern', () => {
  test('returns true for known patterns', () => {
    expect(isFaultPattern('oom_kill')).toBe(true);
    expect(isFaultPattern('zfs_pool_degraded')).toBe(true);
  });

  test('returns false for unknown patterns', () => {
    expect(isFaultPattern('nonexistent')).toBe(false);
    expect(isFaultPattern('')).toBe(false);
    // Prototype-pollution-style keys must not leak through
    expect(isFaultPattern('toString')).toBe(false);
    expect(isFaultPattern('hasOwnProperty')).toBe(false);
  });
});
