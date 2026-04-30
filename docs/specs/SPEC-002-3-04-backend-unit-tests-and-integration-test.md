# SPEC-002-3-04: Per-Backend Unit Tests and Fault-to-Metric Integration Test

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 12 (per-backend unit tests for the four homelab deploy backends), Task 13 (end-to-end fault → fix → metric integration test)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-3-04-backend-unit-tests-and-integration-test.md`

## Description
Deliver the test surface that locks in the homelab plugin's deployment + observability behavior. Four unit-test files (one per backend from SPEC-002-3-01 + SPEC-002-3-02) cover the `DeploymentBackend` interface methods (`build` / `deploy` / `healthCheck` / `rollback`) for happy and sad paths, and run the autonomous-dev SPEC-023-1-04 conformance suite against each backend with mocked connections. One integration test exercises the full chain from observation through promotion through gate approval through fix execution to metric emission, demonstrating that the wiring from SPEC-002-3-03 actually fires under realistic load.

All tests use mocked connections, mocked timers, and mocked metric pipelines for determinism. No real Proxmox / Unraid / Swarm / K3s endpoints are required; the integration test specifically uses a stubbed proxmox-expert agent to keep the test deterministic and offline-capable. Coverage gate is ≥ 90% per backend file (autonomous-dev project standard).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/deploy/backends/proxmox.test.ts` | Create | Unit tests for `ProxmoxHomelabBackend` |
| `plugins/autonomous-dev-homelab/tests/deploy/backends/unraid.test.ts` | Create | Unit tests for `UnraidHomelabBackend` |
| `plugins/autonomous-dev-homelab/tests/deploy/backends/docker-swarm.test.ts` | Create | Unit tests for `DockerSwarmHomelabBackend` |
| `plugins/autonomous-dev-homelab/tests/deploy/backends/k3s.test.ts` | Create | Unit tests for `K3sHomelabBackend` (with mocked `K8sBackend`) |
| `plugins/autonomous-dev-homelab/tests/deploy/conformance.test.ts` | Create | Runs autonomous-dev SPEC-023-1-04 conformance suite against all four backends |
| `plugins/autonomous-dev-homelab/tests/integration/test-fault-to-metric.test.ts` | Create | Full chain integration test |
| `plugins/autonomous-dev-homelab/tests/fixtures/proxmox/` | Create | `pct-create-success.json`, `pct-create-fail.json`, `qm-status-running.json`, `pct-exec-ip.json` |
| `plugins/autonomous-dev-homelab/tests/fixtures/unraid/` | Create | `pull-status-success.json`, `inspect-running.json`, `inspect-unhealthy.json`, `add-container-payload.json`, `shares.json` |
| `plugins/autonomous-dev-homelab/tests/fixtures/docker-swarm/` | Create | `service-inspect.json`, `service-ps-running.json`, `service-rollback-completed.json` |
| `plugins/autonomous-dev-homelab/tests/fixtures/k3s/` | Create | `kubeconfig-scoped.yaml`, `deploy-success.json`, `rollback-success.json` |
| `plugins/autonomous-dev-homelab/tests/fixtures/integration/` | Create | `proxmox-oom-event.json`, `expert-fix-plan.json` |
| `plugins/autonomous-dev-homelab/tests/helpers/mock-connections.ts` | Create | Shared mock factories for `ProxmoxConnection`, `UnraidConnection`, `DockerSwarmConnection`, `K8sConnection` |
| `plugins/autonomous-dev-homelab/tests/helpers/mock-credential-proxy.ts` | Create | Mocked `CredentialProxy` returning fixture-based scoped kubeconfigs |
| `plugins/autonomous-dev-homelab/tests/helpers/mock-metrics.ts` | Create | In-memory metrics pipeline for inspecting emitted values |

## Implementation Details

### Unit-test structure (per backend file)

Each of the four `tests/deploy/backends/*.test.ts` files follows the same outline:

1. **`PARAM_SCHEMA` validation** — at least 2 valid + 4 invalid parameter sets per backend; each invalid case targets a distinct schema rule (required, type, regex, range).
2. **`build` happy path** — mocked connection returns the platform-native success payload; assert returned `BuildArtifact` matches the documented shape (type, location, checksum, sizeBytes, metadata fields).
3. **`build` sad path** — connection returns non-zero exit / 5xx / malformed payload; assert `DeployError` with the right `code` and that `message` contains the truncated stderr.
4. **`deploy` happy path** — assert mock-call order (e.g., `previous_*` capture BEFORE the destructive call), assert returned `DeploymentRecord.hmac` is non-empty AND passes `verifyDeploymentRecord`.
5. **`deploy` sad path** — first attempt fails, retry/error semantics asserted; assert no partial-state persistence.
6. **`deploy` parameter rejection** — at least one invalid-param case (e.g., Unraid path outside shares; Swarm compose-file outside repo; K3s kubeconfig leak attempt).
7. **`healthCheck` happy path** — mock returns healthy payload; assert `healthy: true` and `checks[]` length.
8. **`healthCheck` sad path** — mock returns unhealthy payload; assert `healthy: false` and `unhealthyReason` populated.
9. **`rollback` happy path** — `previous_*` populated; assert rollback call ran and `restoredArtifactId` matches.
10. **`rollback` no-previous** — `previous_*` is null; assert `{ success: false, errors: [...] }` and ZERO destructive calls (mock call count == 0).
11. **No-shell assertion** (K3s only) — spy on `child_process`; assert zero invocations during all four method calls.
12. **Coverage assertion** — Jest/Vitest `expect.coverage` ≥ 90% per source file (`proxmox.ts`, `unraid.ts`, etc.). Coverage gate runs in CI.

### Mock connection helpers (`tests/helpers/mock-connections.ts`)

```ts
export function mockProxmoxConnection(opts?: { execResults?: Map<string, { stdout: string; stderr: string; exitCode: number }> }): ProxmoxConnection;
export function mockUnraidConnection(opts?: { httpResponses?: Map<string, { status: number; body: unknown }>; cachedShares?: string[] }): UnraidConnection;
export function mockDockerSwarmConnection(opts?: { execResults?: Map<string, ...> }): DockerSwarmConnection;
export function mockK8sConnection(opts?: { applyResult?: 'success' | 'opa-rejection' | 'forbidden' }): K8sConnection;
```

- All factories accept opts to override per-call behavior.
- Default opts configure happy-path returns derived from the fixture files.
- Each mock records every call (operation name + arguments) into a public `recordedCalls: Array<{ op: string; args: unknown[] }>` for assertion.

### Conformance suite test (`tests/deploy/conformance.test.ts`)

```ts
import { runConformanceSuite } from '@autonomous-dev/deploy/conformance';
import { ProxmoxHomelabBackend } from '@homelab/deploy/backends/proxmox';
// ...other backends

const backends = [
  { name: 'proxmox', factory: () => new ProxmoxHomelabBackend(mockProxmoxConnection()) },
  { name: 'unraid', factory: () => new UnraidHomelabBackend(mockUnraidConnection()) },
  { name: 'docker-swarm', factory: () => new DockerSwarmHomelabBackend(mockDockerSwarmConnection()) },
  { name: 'k3s', factory: () => new K3sHomelabBackend(mockK8sConnection(), mockCredentialProxy()) },
];

for (const { name, factory } of backends) {
  describe(`conformance: ${name}`, () => {
    runConformanceSuite(factory, {
      sampleParams: loadFixture(`tests/fixtures/${name}/sample-params.json`),
    });
  });
}
```

The `runConformanceSuite` from autonomous-dev SPEC-023-1-04 covers: signed records, parameter validation, idempotent rollback (no `previous_*` returns success: false), `BackendMetadata` shape, and `requiredTools` resolution.

### Integration test (`tests/integration/test-fault-to-metric.test.ts`)

End-to-end chain (all components live except mocked external systems):

1. **Setup**: instantiate `ObservationCollector`, `ObservationPromoter`, `gateApproval`, `ProxmoxHomelabBackend` (mocked Proxmox connection), in-memory autonomous-dev intake queue (mocked), in-memory metrics pipeline, mocked timer (Vitest fake timers), mocked clock-store on tmp dir.
2. **Step 1 — Observation**: feed `tests/fixtures/integration/proxmox-oom-event.json` (synthetic OOM event from a Proxmox node) into `ObservationCollector.process(event)`. Assert one `Observation` is written to `<tmp-data>/observations/<id>.json` with the right `pattern: 'oom-kill'` and `platform: 'homelab-proxmox'`.
3. **Step 2 — Promotion**: assert `ObservationPromoter` submits a `bug`-typed request to the intake queue. Assert `clockStore.start('mttr', observation.id, ...)` was called.
4. **Step 3 — Fix plan**: substitute the proxmox-expert specialist agent (PLAN-002-2) with a stub returning `tests/fixtures/integration/expert-fix-plan.json` (a deterministic fix plan: increase container memory limit to 1024MB, classification: `reversible`, requires L1 approval).
5. **Step 4 — Gate**: invoke `gateApproval(action)`. Assert `clockStore.start('gate-latency', action.id, ...)` was called. Mock the operator-approval to auto-approve. Assert `emitGateLatency` fires with the correct labels and a non-zero `durationMs`.
6. **Step 5 — Fix application**: action invokes `ProxmoxHomelabBackend.deploy(...)` (mocked Proxmox connection accepts the change). Assert the deploy returns a signed record AND the action is marked `resolved: success`.
7. **Step 6 — MTTR emission**: assert `emitMTTR('homelab-proxmox', 'oom-kill', durationMs)` fires with the elapsed time matching `Date.now() - clockStartedAt` (within 100ms tolerance using fake timers).
8. **End-state assertions**:
   - In-memory metrics pipeline contains ONE `homelab_mttr_seconds` observation with the right labels.
   - In-memory metrics pipeline contains ONE `homelab_gate_latency_seconds` observation with `action_type: 'bug'`, `destructiveness: 'reversible'`.
   - In-memory metrics pipeline contains ZERO `homelab_fp_rate` events (the observation resolved, not cancelled).
   - In-memory metrics pipeline contains ZERO `homelab_bypass_attempts_total` events (the operator approved with a valid CONFIRM).
   - `clockStore.purgeStale(0)` returns 0 (no orphaned clocks).

The test must complete in under 5 seconds with fake timers (real wall-clock time), and must be deterministic across 100 consecutive runs (verified by a CI matrix that runs the test 10× per run).

### Fixture details

- `tests/fixtures/proxmox/pct-create-success.json`: `{ "stdout": "extracted volume 'local:vm-100-disk-0'\nextracted volume 'local:vm-100-disk-1'\n", "stderr": "", "exitCode": 0 }`
- `tests/fixtures/proxmox/pct-create-fail.json`: `{ "stdout": "", "stderr": "unable to create CT 100 - storage 'wrong-pool' does not exist\n", "exitCode": 1 }`
- `tests/fixtures/unraid/pull-status-success.json`: `{ "image": "nginx:latest", "digest": "sha256:abc123...", "sizeBytes": 142000000, "status": "complete" }`
- `tests/fixtures/unraid/inspect-unhealthy.json`: `{ "name": "test", "state": { "running": true, "health": { "status": "unhealthy", "failingStreak": 3 } } }`
- `tests/fixtures/integration/proxmox-oom-event.json`: shape matches PLAN-002-1's `Observation` schema input format with `pattern: 'oom-kill'`, `platform: 'homelab-proxmox'`, `resource: 'lxc/100'`.
- `tests/fixtures/integration/expert-fix-plan.json`: shape matches PLAN-002-2's `FixPlan` interface with `classification: 'reversible'`, `actions: [{ kind: 'proxmox-update-resource', params: { vmid: 100, memory_mb: 1024 } }]`.

## Acceptance Criteria

- [ ] Each of the four `tests/deploy/backends/*.test.ts` files contains at minimum 12 distinct `it()` cases covering the outline (PARAM_SCHEMA, build happy/sad, deploy happy/sad/reject, healthCheck happy/sad, rollback happy/no-previous, conformance, no-shell where applicable).
- [ ] Coverage for `src/deploy/backends/proxmox.ts`, `unraid.ts`, `docker-swarm.ts`, `k3s.ts` is ≥ 90% line + branch (verified by Vitest `--coverage` gate in CI; build fails below threshold).
- [ ] Each backend test file completes in under 3 seconds (combined runtime for all four ≤ 12 seconds).
- [ ] `tests/deploy/conformance.test.ts` runs the autonomous-dev SPEC-023-1-04 suite against all four backends; every conformance check passes.
- [ ] No backend test invokes a real network endpoint or shells out to a real binary (verified by `nock`-style network blocking + `child_process` spy showing zero unexpected calls).
- [ ] `mock-connections.ts` factories record every call into `recordedCalls`; tests assert specific call orders using this record.
- [ ] `tests/integration/test-fault-to-metric.test.ts` exercises the full chain (observation → promotion → fix plan → gate → execute → metric) and passes deterministically.
- [ ] Integration test completes in under 5 seconds of wall-clock time (with Vitest fake timers).
- [ ] Integration test asserts EXACT metric counts: 1× `homelab_mttr_seconds`, 1× `homelab_gate_latency_seconds`, 0× `homelab_fp_rate`, 0× `homelab_bypass_attempts_total`.
- [ ] Integration test asserts emit order: MTTR clock starts BEFORE intake submission; gate-latency clock starts BEFORE approval prompt; gate-latency emit fires BEFORE MTTR emit.
- [ ] Integration test runs 10× consecutively in CI without flake (verified by a `--repeat 10` invocation in the test matrix).
- [ ] Test fixtures live under `tests/fixtures/` and are loaded via a `loadFixture(relativePath)` helper that resolves paths relative to the test file's directory.
- [ ] No test relies on environment variables, real disk paths outside `os.tmpdir()`, or wall-clock waits longer than 100ms.
- [ ] All four backend tests use the SAME shared mock factories (no per-test ad-hoc mocks); refactoring a connection interface only requires updating one helper file.
- [ ] CI runs all unit + integration tests on Linux + macOS; both platforms pass.

## Dependencies

- **SPEC-002-3-01**: `ProxmoxHomelabBackend`, `UnraidHomelabBackend` under test.
- **SPEC-002-3-02**: `DockerSwarmHomelabBackend`, `K3sHomelabBackend` under test.
- **SPEC-002-3-03**: metric emitters, clock store, modified promoter / gate / typed-confirm / validator (consumed by integration test).
- **autonomous-dev SPEC-023-1-04**: `runConformanceSuite` exported helper.
- **autonomous-dev SPEC-024-1-03**: `K8sBackend` (mocked under `K3sHomelabBackend`).
- **autonomous-dev SPEC-024-2-01**: `CredentialProxy` interface (mocked).
- **PLAN-002-1** (existing): `ObservationCollector`, `ObservationPromoter`, `Observation` schema.
- **PLAN-002-2** (existing): specialist agent contract, `gateApproval`, `FixPlan` interface.
- **Test runtime**: Vitest (autonomous-dev project standard) with `--coverage` and fake timers; Node `child_process` spy; in-memory FS via `memfs` for clock-store + observation-state isolation.

## Notes
- The 90% coverage gate matches the autonomous-dev project standard. Files that fall below the threshold fail CI; the gate runs on the four `src/deploy/backends/*.ts` files specifically (other plugin code has its own gates in other specs).
- Mocked agent in the integration test (instead of running a real specialist agent) keeps the test offline-capable and deterministic. End-to-end testing with real LLM agents is a separate operator-driven smoke flow documented in PLAN-002-3's testing strategy.
- Vitest fake timers are used to keep the integration test under 5s wall-clock while still asserting the elapsed-time semantics of MTTR and gate-latency. The test advances the fake clock between steps; real timers are restored in `afterEach`.
- The `--repeat 10` flake-check is a pragmatic safeguard against any residual nondeterminism in async ordering. Upgrades to the test runner that improve scheduler determinism may permit lowering this to 3.
- Conformance suite reuse means future autonomous-dev backend-interface changes are caught here automatically — operators upgrade autonomous-dev, this test fails if a homelab backend regressed against the new contract.
- Network blocking via `nock` (or equivalent) is a defense against an accidentally-real fetch in test code; failing fast with "blocked external request" is preferable to a flaky test that silently hits the network.
- Tests do not exercise the Grafana dashboard JSON; that is verified manually per SPEC-002-3-03's acceptance criteria. Adding a JSON-schema validator for Grafana dashboards is a future enhancement.
