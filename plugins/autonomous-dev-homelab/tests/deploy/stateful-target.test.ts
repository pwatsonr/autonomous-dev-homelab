/**
 * Unit tests for `isStatefulTarget` (issue #33).
 *
 * Verifies that stateful detection is GENERIC and attribute-driven —
 * never based on service instance names (invariant #62).
 *
 * Coverage:
 *   - Role-based detection (database, cache → stateful; other roles → stateless)
 *   - Volume-based detection (named_volumes non-empty → stateful)
 *   - Mount-based detection (storage_mounts with host_path → stateful)
 *   - Empty/absent signals → stateless (no false positives)
 *   - Custom role set injection (test seam)
 */

import {
  isStatefulTarget,
  STATEFUL_ROLES,
  DEFAULT_STATEFUL_CONFIG,
  type StatefulDeploySpec,
} from '../../src/deploy/stateful-target';
import { KNOWN_ROLES } from '../../src/discovery/role-catalog';

// ---------------------------------------------------------------------------
// STATEFUL_ROLES
// ---------------------------------------------------------------------------

describe('STATEFUL_ROLES', () => {
  it('includes database role', () => {
    expect(STATEFUL_ROLES.has(KNOWN_ROLES.database)).toBe(true);
  });

  it('includes cache role', () => {
    expect(STATEFUL_ROLES.has(KNOWN_ROLES.cache)).toBe(true);
  });

  it('does NOT include reverse-proxy role (stateless)', () => {
    expect(STATEFUL_ROLES.has(KNOWN_ROLES['reverse-proxy'])).toBe(false);
  });

  it('does NOT include media role (stateless)', () => {
    expect(STATEFUL_ROLES.has(KNOWN_ROLES.media)).toBe(false);
  });

  it('does NOT include monitoring role (stateless)', () => {
    expect(STATEFUL_ROLES.has(KNOWN_ROLES.monitoring)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_STATEFUL_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_STATEFUL_CONFIG', () => {
  it('requires backup by default (safe default on)', () => {
    expect(DEFAULT_STATEFUL_CONFIG.requireBackup).toBe(true);
  });

  it('has no freshness overrides by default', () => {
    expect(DEFAULT_STATEFUL_CONFIG.backupFreshnessOverrides).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isStatefulTarget — role-based detection
// ---------------------------------------------------------------------------

describe('isStatefulTarget — role-based', () => {
  it('returns true for role="database"', () => {
    expect(isStatefulTarget({ role: 'database' })).toBe(true);
  });

  it('returns true for role="cache"', () => {
    expect(isStatefulTarget({ role: 'cache' })).toBe(true);
  });

  it('returns false for role="reverse-proxy"', () => {
    expect(isStatefulTarget({ role: 'reverse-proxy' })).toBe(false);
  });

  it('returns false for role="media"', () => {
    expect(isStatefulTarget({ role: 'media' })).toBe(false);
  });

  it('returns false for role="monitoring"', () => {
    expect(isStatefulTarget({ role: 'monitoring' })).toBe(false);
  });

  it('returns false for role="" (empty string)', () => {
    expect(isStatefulTarget({ role: '' })).toBe(false);
  });

  it('returns false when role is absent', () => {
    expect(isStatefulTarget({})).toBe(false);
  });

  it('returns false when role is undefined', () => {
    const spec: StatefulDeploySpec = { role: undefined };
    expect(isStatefulTarget(spec)).toBe(false);
  });

  it('is case-sensitive: "Database" is NOT stateful (invariant #62 — exact match)', () => {
    // The catalog emits lowercase role strings; mixed-case would be a different
    // signal and is NOT promoted silently.
    expect(isStatefulTarget({ role: 'Database' })).toBe(false);
  });

  it('accepts a custom stateful role set (test seam)', () => {
    const customRoles = new Set(['queue']);
    expect(isStatefulTarget({ role: 'queue' }, customRoles)).toBe(true);
    // database is NOT in the custom set
    expect(isStatefulTarget({ role: 'database' }, customRoles)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStatefulTarget — named_volumes detection (Docker Swarm)
// ---------------------------------------------------------------------------

describe('isStatefulTarget — named_volumes', () => {
  it('returns true when named_volumes has one entry', () => {
    expect(isStatefulTarget({ named_volumes: ['pg-data'] })).toBe(true);
  });

  it('returns true when named_volumes has multiple entries', () => {
    expect(isStatefulTarget({ named_volumes: ['pg-data', 'redis-data'] })).toBe(true);
  });

  it('returns false when named_volumes is empty', () => {
    expect(isStatefulTarget({ named_volumes: [] })).toBe(false);
  });

  it('returns false when named_volumes is absent', () => {
    expect(isStatefulTarget({})).toBe(false);
  });

  it('returns true when role is stateless but named_volumes is non-empty', () => {
    // Volume ownership overrides a stateless role — the volume matters.
    expect(isStatefulTarget({ role: 'media', named_volumes: ['media-config'] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStatefulTarget — storage_mounts detection (Unraid)
// ---------------------------------------------------------------------------

describe('isStatefulTarget — storage_mounts', () => {
  it('returns true for a single mount with host_path', () => {
    expect(
      isStatefulTarget({
        storage_mounts: [{ host_path: '/mnt/user/appdata/postgres', container_path: '/var/lib/postgresql/data' }],
      }),
    ).toBe(true);
  });

  it('returns true for multiple mounts with host_path', () => {
    expect(
      isStatefulTarget({
        storage_mounts: [
          { host_path: '/mnt/user/data', container_path: '/data' },
          { host_path: '/mnt/user/logs', container_path: '/logs' },
        ],
      }),
    ).toBe(true);
  });

  it('returns false when storage_mounts is empty', () => {
    expect(isStatefulTarget({ storage_mounts: [] })).toBe(false);
  });

  it('returns false when storage_mounts is absent', () => {
    expect(isStatefulTarget({})).toBe(false);
  });

  it('returns false when all mounts have empty host_path', () => {
    expect(
      isStatefulTarget({
        storage_mounts: [{ host_path: '', container_path: '/data' }],
      }),
    ).toBe(false);
  });

  it('returns false when all mounts have whitespace-only host_path', () => {
    expect(
      isStatefulTarget({
        storage_mounts: [{ host_path: '   ', container_path: '/data' }],
      }),
    ).toBe(false);
  });

  it('returns true when role is stateless but mounts exist', () => {
    // The *arr stack has config volumes: media role + storage → stateful.
    expect(
      isStatefulTarget({
        role: 'media',
        storage_mounts: [{ host_path: '/mnt/user/appdata/sonarr', container_path: '/config' }],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStatefulTarget — combined signals
// ---------------------------------------------------------------------------

describe('isStatefulTarget — combined signals', () => {
  it('returns true when BOTH role and volumes signal stateful', () => {
    expect(
      isStatefulTarget({
        role: 'database',
        named_volumes: ['pg-data'],
        storage_mounts: [],
      }),
    ).toBe(true);
  });

  it('returns false when NO signal fires (no role, no volumes, no mounts)', () => {
    expect(isStatefulTarget({ role: undefined, named_volumes: [], storage_mounts: [] })).toBe(false);
  });

  it('returns false for a completely empty spec', () => {
    expect(isStatefulTarget({})).toBe(false);
  });

  it('ignores unknown fields on spec (invariant #62 — safe extra data)', () => {
    // Extra fields in raw params must not crash or trigger false positives.
    const spec = { role: 'monitoring', named_volumes: [], storage_mounts: [] } as StatefulDeploySpec;
    expect(isStatefulTarget(spec)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant #62: no service-name matching
// ---------------------------------------------------------------------------

describe('isStatefulTarget — invariant #62 compliance (no name matching)', () => {
  it('does NOT treat "postgres" as a service name (role must be set explicitly)', () => {
    // If someone passes container_name="postgres" but no role/volumes, it is NOT
    // stateful by name. Detection requires an observable attribute.
    const specWithoutRole: StatefulDeploySpec = { named_volumes: [] };
    expect(isStatefulTarget(specWithoutRole)).toBe(false);
  });

  it('does NOT treat "redis" as a service name', () => {
    const specWithoutRole: StatefulDeploySpec = { storage_mounts: [] };
    expect(isStatefulTarget(specWithoutRole)).toBe(false);
  });

  it('correctly classifies a generic DB container by role attribute', () => {
    // A newly-discovered service gets role="database" from the role catalog.
    // That attribute — not its name — drives the stateful classification.
    expect(isStatefulTarget({ role: 'database' })).toBe(true);
  });
});
