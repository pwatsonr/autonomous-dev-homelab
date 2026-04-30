# SPEC-002-1-03: Remaining Seven Probes (Proxmox, UniFi, ZFS, SMART, CertExpiry, BackupOverdue, DaemonHeartbeat)

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 5 (remaining 7 probes)
- **Spec Path (future home)**: /Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-1-03-remaining-seven-probes.md
- **Estimated effort**: 8 hours

## Description
Implement the seven probes covering the medium/slow/daily cadence buckets defined in TDD-002 §6. Each probe extends `BaseProbe` from SPEC-002-1-02, declares its `id`, `platformId`, and `cadence`, and emits typed `Observation` objects per the catalog. Probes have heterogeneous inputs — JSON APIs (Proxmox, UniFi), shell output (`zpool status`, `smartctl`), TLS handshakes (CertExpiry), filesystem reads (BackupOverdue, DaemonHeartbeat) — but they all converge on the same output shape and the same connection-error sentinel pattern from SPEC-002-1-02.

Per-probe parsing logic and at least three fixture-based test cases (clean state, one warning, multiple warnings) are required for every probe. Real network or shell access is forbidden in tests; everything is mocked through the connection or filesystem abstraction.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/observation/probes/proxmox.ts` | Create | `ProxmoxProbe` — `pvesh get /cluster/status` |
| `plugins/autonomous-dev-homelab/src/observation/probes/unifi.ts` | Create | `UnifiProbe` — UniFi events HTTP API |
| `plugins/autonomous-dev-homelab/src/observation/probes/zfs.ts` | Create | `ZFSProbe` — `zpool status` parsing |
| `plugins/autonomous-dev-homelab/src/observation/probes/smart.ts` | Create | `SMARTProbe` — `smartctl --all` per device |
| `plugins/autonomous-dev-homelab/src/observation/probes/cert-expiry.ts` | Create | `CertExpiryProbe` — TLS x509 inspector |
| `plugins/autonomous-dev-homelab/src/observation/probes/backup-overdue.ts` | Create | `BackupOverdueProbe` — manifest age check |
| `plugins/autonomous-dev-homelab/src/observation/probes/daemon-heartbeat.ts` | Create | `DaemonHeartbeatProbe` — heartbeat file mtime |
| `plugins/autonomous-dev-homelab/src/observation/probes/index.ts` | Create | Barrel export of all 9 probes |
| `plugins/autonomous-dev-homelab/tests/observation/probes/{proxmox,unifi,zfs,smart,cert-expiry,backup-overdue,daemon-heartbeat}.test.ts` | Create | One test file per probe, ≥3 cases each |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/proxmox-{healthy,one-down,storage-degraded}.json` | Create | pvesh JSON output fixtures |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/unifi-events-{clean,one-ap-offline,multi-ap-offline}.json` | Create | UniFi events API fixtures |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/zpool-{online,degraded,faulted}.txt` | Create | zpool status text output |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/smartctl-{healthy,reallocated-sectors,pending-sectors}.txt` | Create | smartctl --all text output |

## Implementation Details

### Common shape

Every probe in this spec follows this skeleton:

```typescript
export class XxxProbe extends BaseProbe {
  readonly id = "xxx";
  readonly cadence = "<bucket>" as const;

  constructor(private readonly source: SourceType) { super(); }
  get platformId(): string { return this.source.platformId; }

  async scan(): Promise<Observation[]> {
    try {
      const raw = await this.source.fetch(/* probe-specific call */);
      return this.parse(raw);
    } catch (err) {
      return [this.unreachable(err, "<probe id>")];
    }
  }

  private parse(raw: RawType): Observation[] { /* probe-specific */ }

  private unreachable(err: unknown, probe: string): Observation {
    return this.makeObservation({
      platform: this.platformId,
      pattern: "daemon_heartbeat_stale",
      resource: `${probe}/${this.platformId}`,
      severity: "P0",
      details: { error: String(err), probe, reason: "platform_unreachable" },
    });
  }
}
```

### Per-probe specifics

**ProxmoxProbe** (`cadence: "medium"` — 15min)
- Source: `ProxmoxConnection` (PLAN-001-2) — `conn.exec("pvesh get /cluster/status -output-format json")`.
- Parses `[{ type: "node", name, online }, { type: "storage", storage, status }, ...]`.
- For each `type === "node"` with `online !== 1` → `pattern: "daemon_heartbeat_stale"`, `resource: "node/<name>"`, `severity: "P0"`.
- For each `type === "storage"` with `status !== "available"` → `pattern: "disk_io_error"`, `resource: "storage/<storage>"`, `severity: "P0"`.

**UnifiProbe** (`cadence: "medium"` — 15min)
- Source: `UnifiConnection` exposing `getEvents({ subsystem: "wlan", since: "15m" })`.
- For each event with `key === "EVT_AP_LOST_CONTACT"` → `pattern: "unifi_ap_offline"`, `resource: "ap/<ap_mac>"`, `severity: "P1"`.

**ZFSProbe** (`cadence: "daily"`)
- Source: `SshConnection` to TrueNAS or pool host — `conn.exec("zpool status")` (text).
- Parse: split on `pool: <name>`; capture `state: <STATE>` line per pool. If state ≠ `ONLINE` → `pattern: "zfs_pool_degraded"`, `resource: "pool/<name>"`, `severity: "P0"`, `details: { state, raw: <pool block> }`.

**SMARTProbe** (`cadence: "daily"`)
- Source: `SshConnection.exec("lsblk -dn -o NAME")` to enumerate, then `smartctl --all /dev/<name>` per device.
- Look for attribute IDs `5` (Reallocated_Sectors_Ct) > 0 OR `197` (Current_Pending_Sector) > 0 OR overall-health line not `PASSED`.
- Emit `pattern: "disk_io_error"`, `resource: "disk/<host>:<device>"`, `severity: "P0"`, `details: { reallocated, pending, overall_health }`.

**CertExpiryProbe** (`cadence: "slow"` — 1h)
- Configured endpoint list: `Array<{ host: string; port: number; sni?: string }>` from inventory.
- Uses `node:tls.connect({ host, port, servername }).getPeerCertificate()`; computes days-until-`valid_to`.
- Emit when `daysUntil <= 7`: `pattern: "cert_expiry_imminent"`, `resource: "cert/<host>:<port>"`, `severity: "P2"`, `details: { issuer, valid_to, days_until }`.
- Test must NOT make real TLS calls — inject a `CertFetcher` interface: `fetch(host, port): Promise<{ valid_to: string; issuer: string }>`.

**BackupOverdueProbe** (`cadence: "slow"` — 1h)
- Reads `<homelab-data>/backup-manifest.json`. Schema:
  ```json
  { "backups": [ { "id": "restic-pg", "last_run": "2026-04-29T01:00:00Z", "max_age_hours": 24 } ] }
  ```
- For each backup where `now - last_run > max_age_hours` → `pattern: "backup_overdue"`, `resource: "backup/<id>"`, `severity: "P1"`, `details: { last_run, max_age_hours, age_hours }`.
- If manifest missing/unreadable → single `daemon_heartbeat_stale` observation `resource: "backup-manifest/<homelab-data>"`.

**DaemonHeartbeatProbe** (`cadence: "fast"` — 5min)
- Reads `<autonomous-dev-data>/daemon-heartbeat.json` (path injected via constructor).
- Schema: `{ last_beat: ISO-string, pid: number }`.
- If `now - last_beat > 5 min` OR file missing → `pattern: "daemon_heartbeat_stale"`, `resource: "daemon/autonomous-dev"`, `severity: "P0"`, `details: { last_beat, age_seconds }`.

### `index.ts` — barrel

```typescript
export { K8sProbe } from "./k8s.js";
export { DockerProbe } from "./docker.js";
export { ProxmoxProbe } from "./proxmox.js";
export { UnifiProbe } from "./unifi.js";
export { ZFSProbe } from "./zfs.js";
export { SMARTProbe } from "./smart.js";
export { CertExpiryProbe } from "./cert-expiry.js";
export { BackupOverdueProbe } from "./backup-overdue.js";
export { DaemonHeartbeatProbe } from "./daemon-heartbeat.js";
```

## Acceptance Criteria

**Per-probe (applies to all 7)**
- [ ] Each probe class extends `BaseProbe`, implements `Probe`, and exposes `id`, `platformId`, and `cadence` matching the bucket above.
- [ ] Each probe's test file contains ≥3 cases: clean state (returns `[]`), one warning (returns 1 observation), multiple warnings (returns N observations matching the input).
- [ ] When the probe's underlying call throws, `scan()` resolves to exactly one `daemon_heartbeat_stale` observation and does NOT re-throw.
- [ ] Statement coverage ≥90% per probe file.

**ProxmoxProbe**
- [ ] `proxmox-healthy` fixture → `[]`.
- [ ] `proxmox-one-down` (1 node `online: 0`) → 1 observation, `pattern: "daemon_heartbeat_stale"`, `resource: "node/<name>"`, `severity: "P0"`.
- [ ] `proxmox-storage-degraded` (1 storage `status: "unavailable"`) → 1 observation, `pattern: "disk_io_error"`, `resource: "storage/<id>"`.

**UnifiProbe**
- [ ] `unifi-events-clean` → `[]`.
- [ ] `unifi-events-one-ap-offline` → 1 observation, `pattern: "unifi_ap_offline"`, `resource: "ap/<mac>"`, `severity: "P1"`.
- [ ] `unifi-events-multi-ap-offline` (3 events) → 3 observations.

**ZFSProbe**
- [ ] `zpool-online` → `[]`.
- [ ] `zpool-degraded` → 1 observation, `pattern: "zfs_pool_degraded"`, `details.state === "DEGRADED"`.
- [ ] `zpool-faulted` (multi-pool, one DEGRADED + one FAULTED) → 2 observations.

**SMARTProbe**
- [ ] `smartctl-healthy` → `[]`.
- [ ] `smartctl-reallocated-sectors` (Attr 5 > 0) → 1 observation, `details.reallocated > 0`.
- [ ] `smartctl-pending-sectors` (Attr 197 > 0) → 1 observation, `details.pending > 0`.

**CertExpiryProbe**
- [ ] Fetcher returning `valid_to` 30 days out → `[]`.
- [ ] Fetcher returning `valid_to` 6 days out → 1 observation, `severity: "P2"`, `details.days_until === 6`.
- [ ] Fetcher returning `valid_to` already past → 1 observation, `details.days_until <= 0`.

**BackupOverdueProbe**
- [ ] Manifest with one fresh backup → `[]`.
- [ ] Manifest with one stale backup (age > max_age_hours) → 1 observation, `pattern: "backup_overdue"`.
- [ ] Manifest with 2 stale + 1 fresh → 2 observations.
- [ ] Missing manifest file → 1 `daemon_heartbeat_stale` observation.

**DaemonHeartbeatProbe**
- [ ] `last_beat` 30 seconds ago → `[]`.
- [ ] `last_beat` 10 minutes ago → 1 observation, `pattern: "daemon_heartbeat_stale"`, `severity: "P0"`.
- [ ] Missing heartbeat file → 1 observation, `details.age_seconds` set to `Infinity` or sentinel.

**Module hygiene**
- [ ] `src/observation/probes/index.ts` re-exports all 9 probes (the 2 from SPEC-002-1-02 + the 7 here).
- [ ] All probes compile with `tsc --noEmit` and lint clean.

## Dependencies

- SPEC-002-1-01: `Observation`, `Probe`, `FaultPattern`.
- SPEC-002-1-02: `BaseProbe`.
- PLAN-001-1: inventory entries to know which platforms instantiate which probes (consumed by SPEC-002-1-04 collector — this spec only constructs probes from injected connections).
- PLAN-001-2: `ProxmoxConnection`, `UnifiConnection`, `SshConnection`, `DockerConnection`, `K8sConnection`. All injected via constructor — tests mock.
- Node built-ins: `node:tls`, `node:fs/promises`. No new npm deps.

## Notes

- All probes use the same connection-error → `daemon_heartbeat_stale` sentinel established in SPEC-002-1-02. The collector (SPEC-002-1-04) handles dedup so a probe stuck failing for 1h emits exactly one observation per dedup window.
- `BackupOverdueProbe` and `DaemonHeartbeatProbe` accept the data directory path via constructor injection — do NOT hard-code `<homelab-data>` or `<autonomous-dev-data>` paths. The collector resolves these from `userConfig`.
- `CertExpiryProbe` MUST inject a `CertFetcher` rather than calling `tls.connect` directly inside `scan()`. The tests rely on this seam; production `CertFetcher` implementation lives next to the probe.
- `SMARTProbe` runs against multiple devices per host. Per-device errors should NOT abort the scan — emit per-device observations and an aggregate sentinel only if the `lsblk` enumeration itself fails.
- Future plans add Unraid, TrueNAS-API, SNMP probes by extending the same `BaseProbe`. Do not couple this spec to those — keep `index.ts` flat.
- All fixture files MUST live under `tests/observation/fixtures/` so they can be reused by integration tests in SPEC-002-1-05.
