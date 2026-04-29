# PLAN-002-1: Fault Pattern Catalog + Per-Platform Probes + Observation → Request Promotion

## Metadata
- **Parent TDD**: TDD-002-observation-autofix-migration
- **Estimated effort**: 5 days
- **Dependencies**: []
- **Blocked by**: [PLAN-001-1, PLAN-001-2, PLAN-001-3]
- **Priority**: P0

## Objective
Deliver the active observation layer of the homelab plugin: the fault-pattern catalog per TDD §5 covering common homelab failure modes (CrashLoopBackOff, OOM kill, disk I/O errors, ZFS pool degraded, etc.), per-platform probe implementations per TDD §6 (K8s, Docker, Proxmox, UniFi, ZFS, SMART), and the observation-to-request promotion logic per TDD §7 that submits findings to autonomous-dev's intake queue with appropriate request-type and destructiveness tags. Destructiveness ladder enforcement, specialist agents, migration framework, and homelab deploy backends are layered in by PLAN-002-2 and PLAN-002-3.

## Scope
### In Scope
- Fault pattern catalog at `src/observation/fault-catalog.ts` per TDD §5: 9 initial patterns mapping detection signal → severity (P0/P1/P2) → default request_type (bug/infra/hotfix) → destructiveness category. Catalog is extensible (future plans add patterns).
- Per-platform fault probes at `src/observation/probes/`:
  - `K8sProbe`: queries `kubectl get events --field-selector type=Warning -A -o json`, filters for `BackOff` and `OOMKilled` reasons, emits observations
  - `DockerProbe`: subscribes to `docker events --filter event=oom` stream, emits OOM observations
  - `ProxmoxProbe`: queries Proxmox cluster status via `pvesh get /cluster/status`, detects node-down and storage-degraded
  - `UnifiProbe`: queries UniFi events API for AP-offline events
  - `ZFSProbe`: runs `zpool status` (via TrueNAS API or SSH), detects non-ONLINE pools
  - `SMARTProbe`: runs `smartctl --all` daily on each SSH-accessible host, parses for warnings
  - `CertExpiryProbe`: scans HTTPS endpoints for cert expiry within 7 days
  - `BackupOverdueProbe`: checks `<homelab-data>/backup-manifest.json` for stale backups
  - `DaemonHeartbeatProbe`: monitors autonomous-dev's daemon heartbeat file
- Probe scheduling per TDD §6 cadence:
  - Fast (5min): K8s, Docker, daemon-heartbeat
  - Medium (15min): Proxmox, Unraid
  - Slow (1h): cert expiry, backup overdue
  - Daily: SMART, ZFS scrub status
- `ObservationCollector` at `src/observation/collector.ts` that orchestrates probes, deduplicates observations (1h dedup window per TDD §7), and routes to the promoter
- `ObservationPromoter` at `src/observation/promoter.ts` per TDD §7: maps observations to request_type via `mapToRequestType()` and to destructiveness via `mapToDestructiveness()`, then submits to autonomous-dev's intake queue via `autonomous-dev request submit --type ... --metadata ...`
- Dedup key: `<platform>:<pattern>:<resource>` — same pattern on the same resource within 1h is suppressed
- `Observation` schema at `src/observation/types.ts`: `id`, `platform`, `pattern`, `resource`, `severity`, `details`, `discovered_at`. JSON schema at `schemas/observation-v1.json`.
- Observations persisted at `<homelab-data>/observations/<id>.json` for audit + dedup
- CLI `homelab observe scan [--platform <id>] [--dry-run]` runs probes immediately
- CLI `homelab observe list [--since <ts>] [--platform <id>] [--severity <level>]` shows recent observations
- CLI `homelab observe promote <observation-id>` manually promotes (in case of dedup edge case)
- Unit tests per probe with fixture data (e.g., kubectl JSON output, docker events stream, zpool output)
- Integration test: run `K8sProbe` against a kind cluster with a crashlooping pod, verify observation is generated and promoted

### Out of Scope
- Destructiveness ladder enforcement -- PLAN-002-2
- Specialist agents (proxmox-expert, k8s-expert, etc.) -- PLAN-002-2
- Migration framework -- PLAN-002-2
- Backup orchestration -- PLAN-002-2
- Homelab deploy backends (extending TDD-023's bundled backends) -- PLAN-002-3
- Portal integration -- PLAN-002-3
- Audit & safety metrics -- PLAN-002-3

## Tasks

1. **Author fault pattern catalog** -- Create `src/observation/fault-catalog.ts` with the 9 patterns from TDD §5 as a typed registry. Each entry: `pattern`, `detection`, `severity`, `default_request_type`, `destructiveness`.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/fault-catalog.ts`
   - Acceptance criteria: All 9 patterns from TDD §5 are present. Type guards prevent invalid entries. JSDoc cross-references TDD §5.
   - Estimated effort: 2h

2. **Author `Observation` schema and types** -- Create `src/observation/types.ts` with the `Observation` interface and `schemas/observation-v1.json` JSON Schema. Required: `id` (UUID), `platform`, `pattern`, `resource`, `severity`, `discovered_at`. Optional: `details` (object), `dedup_key`.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/types.ts`, `plugins/autonomous-dev-homelab/schemas/observation-v1.json`
   - Acceptance criteria: TypeScript compiles. JSON schema validates a sample observation. Missing required fields fail.
   - Estimated effort: 1.5h

3. **Implement `K8sProbe`** -- Create `src/observation/probes/k8s.ts` per TDD §6. Uses connection from PLAN-001-2 to invoke `kubectl get events --field-selector type=Warning -A -o json`. Parses output and emits observations.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/probes/k8s.ts`
   - Acceptance criteria: For a kubectl JSON output containing 2 BackOff events and 1 OOMKilled event, emits 3 observations with correct patterns. Tests use fixture JSON.
   - Estimated effort: 2.5h

4. **Implement `DockerProbe`** -- Create `src/observation/probes/docker.ts`. Streams `docker events --since 5m --until 0m --filter event=oom --format json`, parses JSON lines, emits OOM observations.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/probes/docker.ts`
   - Acceptance criteria: For a stream containing 2 OOM events, emits 2 observations with `pattern: 'oom_kill'`. Tests use fixture event-stream data.
   - Estimated effort: 2h

5. **Implement remaining probes** -- ProxmoxProbe, UnifiProbe, ZFSProbe, SMARTProbe, CertExpiryProbe, BackupOverdueProbe, DaemonHeartbeatProbe. Each follows the same shape: query → parse → emit observations.
   - Files to create: 7 probe files under `plugins/autonomous-dev-homelab/src/observation/probes/`
   - Acceptance criteria: Each probe has at least 3 fixture-based test cases (clean state, one warning, multiple warnings). All probes implement a common `Probe` interface (defined in this plan).
   - Estimated effort: 8h

6. **Implement `ObservationCollector`** -- Create `src/observation/collector.ts` that orchestrates probes per the cadence schedule. Uses `node-cron` or equivalent for scheduling. Deduplication via in-memory cache backed by recent observation files.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/collector.ts`
   - Acceptance criteria: K8s, Docker, daemon-heartbeat probes run every 5 minutes. Proxmox, Unraid run every 15. Cert expiry, backup overdue every 1h. SMART, ZFS scrub daily. Dedup correctly suppresses repeat observations within 1h. Tests use mocked timers.
   - Estimated effort: 4h

7. **Implement `ObservationPromoter`** -- Create `src/observation/promoter.ts` per TDD §7. `mapToRequestType` and `mapToDestructiveness` use the catalog. Submission via `execFile('autonomous-dev', ['request', 'submit', ...])`.
   - Files to create: `plugins/autonomous-dev-homelab/src/observation/promoter.ts`
   - Acceptance criteria: For an OOM observation, request_type is `bug` and destructiveness is `persistent-modifying`. For ZFS degraded, request_type is `infra`, destructiveness is `data-affecting`. Submission produces a real intake entry (verified in tests via mocked execFile).
   - Estimated effort: 3h

8. **Implement observation persistence** -- Save each observation to `<homelab-data>/observations/<id>.json` atomically. Cleanup retention: 90 days.
   - Files to modify: `plugins/autonomous-dev-homelab/src/observation/collector.ts`
   - Acceptance criteria: Observation written atomically. Read-back validates against the schema. Cleanup runs daily and removes files older than 90 days. Tests verify both.
   - Estimated effort: 2h

9. **Implement `homelab observe scan/list/promote` CLI** -- `observe scan` runs probes immediately (skipping the scheduled cadence). `observe list` filters and prints recent observations. `observe promote <id>` manually promotes a deduplicated observation.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/observe.ts`
   - Acceptance criteria: `observe scan --platform proxmox-01` runs only that platform's probes. `observe list --since 1h --severity P0` filters correctly. `observe promote OBS-123` re-submits to intake even if previously deduplicated. Tests cover all three.
   - Estimated effort: 3h

10. **Unit tests per probe + collector + promoter** -- One test file per component covering all paths.
    - Files to create: 11+ test files under `plugins/autonomous-dev-homelab/tests/observation/`
    - Acceptance criteria: All tests pass. Coverage ≥90% per probe. Fixture-based; no real platform connections.
    - Estimated effort: 6h

11. **Integration test: K8s end-to-end** -- `tests/integration/test-k8s-observation.test.ts` runs the K8s probe against a kind cluster with a deliberately crashlooping pod. Verifies: observation generated, dedup works (second scan within 1h suppresses), promotion submits to a mocked autonomous-dev CLI.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-k8s-observation.test.ts`
    - Acceptance criteria: Kind cluster set up with a CrashLoopBackOff pod. Probe detects it. Observation persisted. Promotion logged. Re-run within 1h doesn't re-promote.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `Observation` schema and `Probe` interface consumed by PLAN-002-2 (specialist agents read observations) and PLAN-002-3 (portal displays them).
- Fault pattern catalog extensible by future plans (e.g., a security-scanning plan adds patterns for compromised hosts).
- Observation-promotion pattern reusable for any future autonomous workflow that converts events into requests.
- Probe-cadence scheduler reusable for any future periodic background task.

**Consumes from other plans:**
- **PLAN-001-1** (blocking): `InventoryManager` to know which platforms exist.
- **PLAN-001-2** (blocking): `Connection` subclasses for executing probe commands.
- **PLAN-001-3** (blocking): audit log writer for observation events.
- TDD-018 / PLAN-018-3 (autonomous-dev): `request submit --type bug` CLI used by the promoter.
- Connection pool (PLAN-001-2) for connection reuse across probes.

## Testing Strategy

- **Unit tests per probe (task 10):** ≥90% coverage. Fixture-based.
- **Integration test (task 11):** K8s end-to-end against kind cluster.
- **Cadence test:** Mocked timers verify probe scheduling matches TDD §6.
- **Dedup test:** Same observation submitted twice within 1h; only first promotes.
- **Promotion test:** Each pattern → request_type/destructiveness mapping verified.
- **Manual smoke:** Real homelab with at least 2 platforms; let probes run for 24h; verify observations look reasonable.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Probes generate false positives, flooding the intake queue | High | Medium -- alert fatigue | Conservative defaults + 1h dedup window. Each probe has a "test mode" (`--dry-run`) for operators to validate behavior before enabling. False-positive rate tracked in PLAN-002-3's safety metrics; auto-disable a probe if FP rate exceeds 50% over 30 days. |
| Probes consume significant resources on monitored platforms (e.g., K8s API server load) | Medium | Medium -- ops impact on the platform | Default cadence is conservative (5 min for fast probes). Each probe declares an estimated load impact. Operators can lower frequency via `<homelab-data>/probe-config.yaml`. |
| Network-disconnect during a probe scan results in observation marked "platform unreachable" rather than reflecting actual state | Medium | Low -- noisy observations | Probes treat connection errors as a separate observation type (`platform_unreachable`) — not a fault on the platform. Dedup applies. Operators see a clear distinction. |
| Promoter submits to autonomous-dev with stale or wrong metadata | Low | High -- wrong-type request created | Promoter uses the catalog (typed, tested). Each promotion's metadata is recorded in the audit log; operators can review and correct via `observe promote --override-type`. |
| 90-day observation retention fills disk on busy homelabs (10k observations/month) | Medium | Low -- daily cleanup mitigates | Cleanup daily. Configurable retention via env. Operators with high-frequency events can lower to 30 days. |
| `kubectl get events` JSON format changes between K8s versions, breaking K8sProbe | Medium | Medium -- probe stops detecting | K8sProbe declares `min_k8s_version` in its metadata. Older clusters get a clear "K8s 1.22+ required" warning. Test corpus includes K8s 1.22, 1.25, 1.28 outputs. |

## Definition of Done

- [ ] Fault pattern catalog covers all 9 patterns from TDD §5
- [ ] All 9 probes implement the common `Probe` interface
- [ ] `ObservationCollector` schedules probes per the cadence in TDD §6
- [ ] Dedup correctly suppresses repeat observations within 1h
- [ ] `ObservationPromoter` correctly maps to request_type and destructiveness
- [ ] Promotion submits to autonomous-dev's intake via the CLI
- [ ] Observations persisted at `<homelab-data>/observations/<id>.json`
- [ ] 90-day retention with daily cleanup
- [ ] `homelab observe scan/list/promote` CLI subcommands work with JSON output
- [ ] Unit tests pass with ≥90% coverage per probe
- [ ] Integration test demonstrates K8s observation end-to-end against kind
- [ ] Audit entries emitted for every observation and promotion
- [ ] Operator documentation covers each fault pattern and its detection
- [ ] No regressions in PLAN-001-1/2/3 functionality
