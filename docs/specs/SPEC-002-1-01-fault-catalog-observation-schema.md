# SPEC-002-1-01: Fault Pattern Catalog + Observation Schema & Types

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 1 (fault pattern catalog), Task 2 (Observation schema and types)
- **Spec Path (future home)**: /Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-1-01-fault-catalog-observation-schema.md
- **Estimated effort**: 3.5 hours

## Description
Author the foundation modules consumed by every probe and by the promoter: the typed `FAULT_CATALOG` registry mapping each TDD-002 §5 detection pattern to its severity, default `request_type`, and destructiveness category, plus the `Observation` TypeScript interface and the matching `observation-v1.json` JSON Schema. This spec ships pure declarative artifacts — no probes, no scheduler, no CLI. Downstream specs (SPEC-002-1-02 through SPEC-002-1-04) import from these modules; they are the contract that lets per-probe and promoter work proceed in parallel.

The catalog must be type-narrow so the TypeScript compiler rejects unknown patterns at the call site, and the JSON schema must validate observation files written to disk in SPEC-002-1-04. Both artifacts cross-reference TDD-002 §5 / §7 in JSDoc and in the schema description so that future contributors can extend them safely.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/observation/fault-catalog.ts` | Create | Typed registry of 9 patterns from TDD-002 §5 |
| `plugins/autonomous-dev-homelab/src/observation/types.ts` | Create | `Observation`, `Severity`, `RequestType`, `Destructiveness`, `Probe` types |
| `plugins/autonomous-dev-homelab/schemas/observation-v1.json` | Create | JSON Schema (draft-07) for persisted observations |
| `plugins/autonomous-dev-homelab/tests/observation/fault-catalog.test.ts` | Create | Verifies all 9 patterns + invalid-entry guards |
| `plugins/autonomous-dev-homelab/tests/observation/types.test.ts` | Create | Validates schema against fixture observations |

## Implementation Details

### `types.ts` — Core types

```typescript
export type Severity = "P0" | "P1" | "P2";
export type RequestType = "bug" | "infra" | "hotfix";
export type Destructiveness =
  | "read-only"
  | "reversible"
  | "persistent-modifying"
  | "data-affecting"
  | "architectural";

export type FaultPattern =
  | "crash_loop"
  | "oom_kill"
  | "disk_io_error"
  | "zfs_pool_degraded"
  | "unifi_ap_offline"
  | "cert_expiry_imminent"
  | "backup_overdue"
  | "service_5xx"
  | "daemon_heartbeat_stale";

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

/** Common interface every probe in SPEC-002-1-02/03 must implement. */
export interface Probe {
  readonly id: string;          // e.g. "k8s", "docker"
  readonly platformId: string;  // inventory platform id
  readonly cadence: "fast" | "medium" | "slow" | "daily";
  scan(): Promise<Observation[]>;
}
```

### `fault-catalog.ts` — Typed registry

```typescript
import type { FaultPattern, Severity, RequestType, Destructiveness } from "./types.js";

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
 * Source of truth: TDD-002 §5 (table).
 * Extended by future plans (e.g. security, capacity).
 */
export const FAULT_CATALOG: Readonly<Record<FaultPattern, FaultCatalogEntry>> = Object.freeze({
  crash_loop: {
    pattern: "crash_loop",
    detection: "k8s events / docker restart count",
    severity: "P1",
    default_request_type: "bug",
    destructiveness: "reversible",
  },
  oom_kill: {
    pattern: "oom_kill",
    detection: "k8s events / docker stats / dmesg",
    severity: "P1",
    default_request_type: "bug",
    destructiveness: "persistent-modifying",
  },
  disk_io_error: {
    pattern: "disk_io_error",
    detection: "SMART warnings / dmesg",
    severity: "P0",
    default_request_type: "infra",
    destructiveness: "data-affecting",
  },
  zfs_pool_degraded: {
    pattern: "zfs_pool_degraded",
    detection: "zpool status non-ONLINE",
    severity: "P0",
    default_request_type: "infra",
    destructiveness: "data-affecting",
  },
  unifi_ap_offline: {
    pattern: "unifi_ap_offline",
    detection: "UniFi events API",
    severity: "P1",
    default_request_type: "bug",
    destructiveness: "reversible",
  },
  cert_expiry_imminent: {
    pattern: "cert_expiry_imminent",
    detection: "x509 issuer scan within 7d",
    severity: "P2",
    default_request_type: "hotfix",
    destructiveness: "reversible",
  },
  backup_overdue: {
    pattern: "backup_overdue",
    detection: "manifest age check >24h",
    severity: "P1",
    default_request_type: "infra",
    destructiveness: "reversible",
  },
  service_5xx: {
    pattern: "service_5xx",
    detection: "HTTP probe sustained 5xx >5min",
    severity: "P1",
    default_request_type: "bug",
    destructiveness: "reversible",
  },
  daemon_heartbeat_stale: {
    pattern: "daemon_heartbeat_stale",
    detection: "autonomous-dev daemon heartbeat file stale",
    severity: "P0",
    default_request_type: "hotfix",
    destructiveness: "reversible",
  },
});

export function isFaultPattern(value: string): value is FaultPattern {
  return value in FAULT_CATALOG;
}
```

### `observation-v1.json` — JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://autonomous-dev/schemas/observation-v1.json",
  "title": "Observation",
  "description": "A single fault detection emitted by a homelab probe. See TDD-002 §5/§7.",
  "type": "object",
  "required": ["id", "platform", "pattern", "resource", "severity", "discovered_at"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "platform": { "type": "string", "minLength": 1 },
    "pattern": {
      "type": "string",
      "enum": [
        "crash_loop", "oom_kill", "disk_io_error", "zfs_pool_degraded",
        "unifi_ap_offline", "cert_expiry_imminent", "backup_overdue",
        "service_5xx", "daemon_heartbeat_stale"
      ]
    },
    "resource": { "type": "string", "minLength": 1 },
    "severity": { "type": "string", "enum": ["P0", "P1", "P2"] },
    "discovered_at": { "type": "string", "format": "date-time" },
    "details": { "type": "object" },
    "dedup_key": { "type": "string", "minLength": 1 }
  }
}
```

## Acceptance Criteria

- [ ] `FAULT_CATALOG` contains exactly 9 entries with keys matching the `FaultPattern` union.
- [ ] Each entry's `severity`, `default_request_type`, and `destructiveness` match TDD-002 §5 row-for-row (verified by table-driven test).
- [ ] `FAULT_CATALOG` is `Object.freeze`d; attempting to mutate throws in strict mode (verified by test).
- [ ] `isFaultPattern("oom_kill") === true` and `isFaultPattern("nonexistent") === false`.
- [ ] `Observation` interface compiles without `any`; `tsc --noEmit` passes.
- [ ] `observation-v1.json` is valid draft-07 (passes `ajv compile`).
- [ ] A fixture observation `{ id, platform, pattern, resource, severity, discovered_at }` validates; an observation missing any required field fails with a schema error naming the missing field.
- [ ] An observation with `pattern: "unknown_pattern"` fails schema validation.
- [ ] An observation with `discovered_at: "not-a-date"` fails schema validation.
- [ ] JSDoc on `FAULT_CATALOG` references "TDD-002 §5"; JSDoc on `Probe` references "SPEC-002-1-02 / SPEC-002-1-03".

## Dependencies

- TypeScript ≥5.0 (already pinned for the plugin).
- `ajv` (already a dev dep) for schema-validation tests.
- No runtime dependency on PLAN-001 modules; types only.

## Notes

- The catalog is the single source of truth for `mapToRequestType` / `mapToDestructiveness` in SPEC-002-1-04. Do not duplicate the mapping in the promoter — import from this module.
- `dedup_key` is intentionally optional in the schema because the collector computes it on persistence (SPEC-002-1-04). Probes may leave it unset; tests should accept both.
- Future plans extending the catalog must add to BOTH `FaultPattern` union AND `FAULT_CATALOG` AND the JSON schema `enum`. A type-level `satisfies Record<FaultPattern, ...>` on the catalog ensures the compiler enforces this.
- No test should hit a real cluster, network, or filesystem outside the test temp dir.
