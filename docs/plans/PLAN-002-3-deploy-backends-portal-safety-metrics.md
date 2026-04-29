# PLAN-002-3: Homelab Deploy Backends + Portal Integration + Audit & Safety Metrics

## Metadata
- **Parent TDD**: TDD-002-observation-autofix-migration
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-002-1, PLAN-002-2]
- **Priority**: P0

## Objective
Complete the homelab plugin with operator-facing observability and integration: homelab deploy backends per TDD §12 that extend autonomous-dev's TDD-023 backends with platform-specific implementations (`proxmox`, `unraid`, `docker-swarm`, `k3s` running on the homelab itself), portal integration per TDD §13 that adds a "Homelab" panel to the autonomous-dev portal showing inventory, observations, pending actions, and migration status, and the audit + safety metrics per TDD §14 covering MTTR (mean time to recovery for observed faults), false-positive rate per probe, and approval-gate latency. This plan ties the homelab plugin into the broader autonomous-dev ecosystem.

## Scope
### In Scope
- Four homelab deploy backends per TDD §12, each shipped as separate plugin packages or as part of `autonomous-dev-homelab`:
  - `proxmox`: deploys via `pct create` (containers) or `qm create` (VMs); pulls images from a configured registry; SSH cert-authenticated via PLAN-001-2's CA
  - `unraid`: deploys Docker containers via Unraid's emhttp API; persistent storage via Unraid arrays
  - `docker-swarm`: deploys via `docker stack deploy` against a Swarm manager
  - `k3s`: deploys via `kubectl apply` against a homelab K3s cluster (uses the existing K8s cloud backend from PLAN-024-1 with homelab-specific defaults)
- Each backend implements PLAN-023-1's `DeploymentBackend` interface: `build()`, `deploy()`, `healthCheck()`, `rollback()`. Build is platform-specific (e.g., proxmox builds a container image via `pct create`); deploy invokes the platform's API.
- Backend metadata declares `supportedTargets: ['homelab-proxmox', 'homelab-unraid', ...]` matching the inventory entry types from PLAN-001-1
- Conformance suite extension: each new backend passes the same suite as PLAN-023-1's bundled backends
- Portal integration per TDD §13:
  - "Homelab" tab/panel added to the autonomous-dev portal (PLAN-013-3, existing on main)
  - Panel sections: Inventory (list of platforms with status), Observations (recent + filtered), Pending Actions (24h delays in flight, awaiting CONFIRM), Migrations (in-flight + recent), Audit (recent safety events)
  - Real-time updates via portal SSE (PLAN-015-1, existing on main): new observations appear without refresh; status changes propagate
  - Read-only by default; destructive actions require navigating to CLI for the typed-CONFIRM (consistent with TDD §8 safety model)
- Audit & safety metrics per TDD §14:
  - MTTR per platform per fault pattern (median time from observation → resolution)
  - False-positive rate per probe (observations promoted but later cancelled or auto-rolled back)
  - Approval-gate latency (time from gate fired → operator approved/rejected)
  - Bypass-attempt count (config-below-floor, wrong CONFIRM, missing admin)
- Metrics emitted to the existing TDD-007 metrics pipeline; consumable by Grafana dashboards
- CLI `homelab metrics show [--metric mttr|fp_rate|gate_latency|bypass_attempts]` displays current metric values
- CLI `homelab portal` opens the homelab panel in the browser (delegates to `autonomous-dev portal open --tab homelab`)
- Dashboard JSON template at `<plugin>/dashboards/homelab.json` for Grafana import (operator-installable)
- Unit tests per backend: build/deploy/healthCheck/rollback against fixture connections
- Integration test: end-to-end fault → observation → promotion → fix-action → metric emission

### Out of Scope
- Fault probes and observation collection -- delivered by PLAN-002-1
- Destructiveness ladder, specialist agents, migration framework, backup orchestration -- delivered by PLAN-002-2
- Portal infrastructure (server, routing, SSE, auth) -- existing PLAN-013/014/015 in autonomous-dev
- Grafana installation / configuration -- ops concern
- Cross-cloud deploy (`gcp`, `aws`, `azure`) -- delivered by PLAN-024-1 in autonomous-dev
- Automatic dashboard provisioning into operator's Grafana -- this plan ships the JSON; operator imports manually

## Tasks

1. **Implement `ProxmoxHomelabBackend`** -- Create `src/deploy/backends/proxmox.ts` extending PLAN-023-1's `DeploymentBackend`. `build()` runs `pct create <vmid> <image>` (for containers) or `qm create` (for VMs). `deploy()` starts the container/VM and assigns IP. `healthCheck()` curls a configured endpoint. `rollback()` stops the new container and starts the previous one (if previous record exists).
   - Files to create: `plugins/autonomous-dev-homelab/src/deploy/backends/proxmox.ts`
   - Acceptance criteria: Backend metadata has `name: 'proxmox'`, `supportedTargets: ['homelab-proxmox']`. Conformance suite passes. Tests use mocked Proxmox connection.
   - Estimated effort: 4h

2. **Implement `UnraidHomelabBackend`** -- Create `src/deploy/backends/unraid.ts`. `build()` pulls a Docker image via Unraid's `docker pull`. `deploy()` creates a container via Unraid's `emhttp` API with persistent storage on Unraid arrays. `healthCheck()` polls a configured URL. `rollback()` removes the new container and starts the previous one.
   - Files to create: `plugins/autonomous-dev-homelab/src/deploy/backends/unraid.ts`
   - Acceptance criteria: Backend metadata: `name: 'unraid'`, `supportedTargets: ['homelab-unraid']`. Conformance suite passes. Persistent storage path is configurable per-deploy.
   - Estimated effort: 4h

3. **Implement `DockerSwarmHomelabBackend`** -- Create `src/deploy/backends/docker-swarm.ts`. `build()` is a no-op (assumes image already in registry). `deploy()` runs `docker stack deploy --compose-file <file> <stack>` against a Swarm manager. `healthCheck()` polls the service's internal endpoint via `docker service ps`. `rollback()` runs `docker service rollback <name>`.
   - Files to create: `plugins/autonomous-dev-homelab/src/deploy/backends/docker-swarm.ts`
   - Acceptance criteria: Backend metadata: `name: 'docker-swarm'`. Conformance suite passes. Swarm manager configurable in `deploy.yaml`.
   - Estimated effort: 3h

4. **Implement `K3sHomelabBackend`** -- Create `src/deploy/backends/k3s.ts`. Wraps PLAN-024-1's `K8sBackend` with homelab-specific defaults (e.g., `default_namespace: 'default'`, scoped kubeconfig from PLAN-024-2's `CredentialProxy`). The credential proxy issues 15-min K8s tokens scoped to the configured namespace.
   - Files to create: `plugins/autonomous-dev-homelab/src/deploy/backends/k3s.ts`
   - Acceptance criteria: Backend metadata: `name: 'k3s'`. Conformance suite passes. CredentialProxy is consulted for each deploy (15-min scoped token). Tests use a kind cluster simulating K3s.
   - Estimated effort: 4h

5. **Register backends with autonomous-dev's BackendRegistry** -- Add a startup hook in the homelab plugin that registers all four backends with PLAN-023-1's `BackendRegistry`. The registration triggers PLAN-019-3's trust validation; backends must be allowlisted in `extensions.privileged_backends` (delegating to PLAN-024-2's allowlist mechanism).
   - Files to modify: `plugins/autonomous-dev-homelab/src/index.ts` (plugin entry point)
   - Acceptance criteria: After plugin load, `deploy backends list` shows all 4 homelab backends. Each requires allowlist entry. Tests verify registration.
   - Estimated effort: 1.5h

6. **Add "Homelab" panel to the portal** -- Create the portal-side templates and routes per TDD §13. Sections: Inventory, Observations, Pending Actions, Migrations, Audit. Uses existing portal infrastructure (PLAN-013/014/015 of autonomous-dev).
   - Files to create: `plugins/autonomous-dev-homelab/src/portal/homelab-panel.ts`, `templates/homelab.html`
   - Acceptance criteria: Navigating to `/portal/homelab` shows the panel. Each section pulls live data from the homelab plugin's state files. Real-time updates via SSE work for observations and pending-action status. Tests use mocked SSE events.
   - Estimated effort: 4h

7. **Implement metrics emitters** -- Create `src/metrics/emitters.ts` with helpers: `emitMTTR(platform, pattern, durationMs)`, `emitFPRate(probe, isFalsePositive)`, `emitGateLatency(action, durationMs)`, `emitBypassAttempt(operator, reason)`. Each emits to the TDD-007 metrics pipeline.
   - Files to create: `plugins/autonomous-dev-homelab/src/metrics/emitters.ts`
   - Acceptance criteria: Each emitter produces a structured event. Metric names are stable (used in dashboard queries). Tests verify emission for each path.
   - Estimated effort: 2h

8. **Wire metrics into observation/action flow** -- Modify PLAN-002-1's promoter to start the MTTR clock at observation. Modify PLAN-002-2's gate to start the gate-latency clock. On request resolution (success or rollback), emit MTTR. On gate completion, emit latency. On false-positive cancel, emit FP-rate event.
   - Files to modify: `src/observation/promoter.ts`, `src/safety/gate.ts`, `src/safety/typed-confirm.ts`, `src/safety/validator.ts`
   - Acceptance criteria: Each trigger emits the right metric. Tests verify end-to-end emission for MTTR, FP-rate, gate-latency, bypass-attempt scenarios.
   - Estimated effort: 3h

9. **Implement `homelab metrics show` CLI** -- `homelab metrics show [--metric <name>]` queries the TDD-007 metrics pipeline and displays current values. Without `--metric`, shows summary of all four.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/metrics.ts`
   - Acceptance criteria: `metrics show` prints all four metrics with current values + 30-day trend. `--metric mttr` shows MTTR breakdown by platform + pattern. JSON mode emits structured. Tests use mocked metrics pipeline.
   - Estimated effort: 2h

10. **Author Grafana dashboard JSON** -- Create `plugins/autonomous-dev-homelab/dashboards/homelab.json` with panels for: per-platform observation count, MTTR by pattern, FP-rate trend, gate-latency p95, bypass-attempt timeline.
    - Files to create: `plugins/autonomous-dev-homelab/dashboards/homelab.json`
    - Acceptance criteria: JSON is a valid Grafana dashboard (importable via Grafana UI). Operators can install via Grafana's Import feature. Documented in operator guide. Manual smoke test with a real Grafana instance.
    - Estimated effort: 3h

11. **Implement `homelab portal` CLI** -- `homelab portal` opens the homelab panel in the operator's browser (delegates to `autonomous-dev portal open --tab homelab`).
    - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/portal.ts`
    - Acceptance criteria: Command opens the URL via `open` (macOS) / `xdg-open` (Linux). Tests verify the right URL is constructed.
    - Estimated effort: 1h

12. **Unit tests per backend** -- One test file per homelab deploy backend covering build/deploy/healthCheck/rollback. Conformance suite tests automatically apply.
    - Files to create: 4 test files under `plugins/autonomous-dev-homelab/tests/deploy/backends/`
    - Acceptance criteria: All tests pass. Coverage ≥90% per backend file. Mocked connections.
    - Estimated effort: 4h

13. **Integration test: end-to-end fault → fix → metric** -- `tests/integration/test-fault-to-metric.test.ts` simulates an OOM observation on Proxmox, promotion to bug-typed request, proxmox-expert produces a fix plan, gate approves, fix applied, MTTR emitted. Verifies the full chain.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-fault-to-metric.test.ts`
    - Acceptance criteria: Test passes deterministically (mocked agent, mocked timer). All metric emissions happen in order. End state shows MTTR, observation count, gate latency.
    - Estimated effort: 4h

## Dependencies & Integration Points

**Exposes to other plans:**
- Four homelab deploy backends consumed by autonomous-dev's `BackendRegistry`. Operators with homelab inventories see them in `deploy backends list`.
- "Homelab" portal panel as the canonical operator view of homelab state.
- Safety metrics consumed by Grafana dashboards (operator-installable).
- `homelab metrics show` and `homelab portal` CLI patterns reusable for future plugins.

**Consumes from other plans:**
- **PLAN-002-1** (blocking): observation collector emits the events that drive MTTR.
- **PLAN-002-2** (blocking): gate latency, bypass attempts, typed-CONFIRM all emit metrics.
- **PLAN-001-2** (existing): connection layer used by all four homelab deploy backends.
- **PLAN-023-1** (autonomous-dev existing): `DeploymentBackend` interface and conformance suite.
- **PLAN-024-1/2** (autonomous-dev existing): K8sBackend (extended for K3s) and CredentialProxy.
- **PLAN-013/014/015** (autonomous-dev existing): portal infrastructure.
- TDD-007 / PLAN-007-X (autonomous-dev): metrics pipeline.

## Testing Strategy

- **Unit tests per backend (task 12):** ≥90% coverage. Conformance suite automatically applied.
- **Integration test (task 13):** End-to-end fault → fix → metric emission.
- **Portal smoke:** Real portal with the homelab panel; verify SSE updates, navigation, data freshness.
- **Dashboard import test:** Operator imports `homelab.json` into a real Grafana; verify panels render with synthetic data.
- **Cross-platform:** Conformance suite runs on Linux + macOS (for the portal panel); homelab deploy backends are Linux-primary, macOS for Docker-only.
- **Manual smoke:** Real homelab with at least 2 platforms; deploy a fixture container via each backend; verify all metrics emitted; check portal panel.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Operator's homelab Proxmox doesn't have the API enabled or has a different version | Medium | Medium -- backend doesn't work | Backend's `metadata.min_proxmox_version: '7.0'` documented. Connection-test (PLAN-001-2) verifies API access at platform setup. Failure mode is clear. |
| Portal panel shows stale data when SSE connection drops | Medium | Low -- data freshness lags | SSE auto-reconnects within 5s. Last-update timestamp shown in panel header. Operators can manually refresh. |
| Grafana dashboard JSON drifts as plugin metrics evolve | High | Low -- panels show "no data" or wrong queries | Dashboard versioned alongside plugin. Major plugin versions document required dashboard updates. Operator guide notes "re-import dashboard after plugin upgrade." |
| Bypass-attempt metric is gameable (operator with admin role can clear the metric file) | Low | Medium -- governance hole | Metric is emitted to TDD-007 pipeline (operator can't easily clear cloud-side metrics). Local cache is for display only. Documented. |
| K3s backend's CredentialProxy dependency creates a circular plugin dependency (homelab depends on autonomous-dev-deploy-k8s) | Medium | Medium -- complex install ordering | Document the install order: `autonomous-dev-deploy-k8s` first, then `autonomous-dev-homelab`. Plugin manifest declares `depends_on: ['autonomous-dev-deploy-k8s']` so PLAN-019-1's discovery enforces ordering. |
| Homelab deploy backend running on the daemon's own host (e.g., docker-swarm where the daemon IS in the swarm) creates self-modify risk | Medium | High -- daemon could redeploy itself, causing crash | Documented as a known constraint. Operators are warned: "Don't put autonomous-dev daemon under management of itself." Future enhancement: detect and refuse self-modification. |

## Definition of Done

- [ ] All four homelab deploy backends implement `DeploymentBackend` and pass the conformance suite
- [ ] Backends are registered with autonomous-dev's `BackendRegistry` on plugin load
- [ ] Each backend appears in `deploy backends list` after install + allowlist
- [ ] "Homelab" portal panel renders Inventory, Observations, Pending Actions, Migrations, Audit sections
- [ ] SSE updates propagate observation status changes in real-time
- [ ] All four metrics (MTTR, FP-rate, gate-latency, bypass-attempts) emit to TDD-007 pipeline
- [ ] `homelab metrics show` and `homelab portal` CLI subcommands work
- [ ] Grafana dashboard JSON imports cleanly into a real Grafana instance
- [ ] Unit tests pass with ≥90% coverage per backend
- [ ] Integration test demonstrates fault → fix → metric emission
- [ ] Operator documentation describes installing dashboards, configuring backends, navigating the portal
- [ ] No regressions in PLAN-002-1/2 functionality
- [ ] Plugin install order is documented (autonomous-dev-deploy-k8s before autonomous-dev-homelab)
