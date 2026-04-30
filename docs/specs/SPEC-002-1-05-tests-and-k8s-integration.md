# SPEC-002-1-05: Per-Probe Unit Tests + K8s End-to-End Integration Test

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 10 (per-probe unit tests + collector + promoter), Task 11 (K8s end-to-end integration test against kind cluster)
- **Spec Path (future home)**: /Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-1-05-tests-and-k8s-integration.md
- **Estimated effort**: 9 hours

## Description
Consolidate and verify the testing posture for PLAN-002-1. Specs SPEC-002-1-02 / 03 / 04 each ship per-component tests; this spec audits and tightens those into a uniform suite that meets ≥90% coverage per probe and exercises the full collector + promoter + dedup loop with mocked timers. Then layer a single end-to-end integration test that stands up a kind (Kubernetes-in-Docker) cluster, deploys a deliberately crashlooping pod, runs the K8sProbe through the real collector, and verifies an observation is persisted, promoted to a mocked autonomous-dev binary, and suppressed on a second run within 1h.

This is the gating spec for PLAN-002-1: when these tests pass in CI, the plan is done.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/observation/probes/coverage.audit.test.ts` | Create | Verifies coverage thresholds per probe in a single audit run |
| `plugins/autonomous-dev-homelab/tests/observation/integration/collector-promoter-flow.test.ts` | Create | End-to-end of collector + promoter + dedup with mocked probes and execFile |
| `plugins/autonomous-dev-homelab/tests/integration/test-k8s-observation.test.ts` | Create | kind cluster + crashlooping pod + real K8sProbe |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/k8s-crashloop-pod.yaml` | Create | Pod manifest that intentionally exits 1 in a tight loop |
| `plugins/autonomous-dev-homelab/tests/integration/helpers/kind-cluster.ts` | Create | `setupKind()` / `teardownKind()` helpers wrapping `kind create cluster` |
| `plugins/autonomous-dev-homelab/tests/integration/helpers/mock-autonomous-dev.ts` | Create | Shell script writer that creates a fake `autonomous-dev` bin recording invocations |
| `plugins/autonomous-dev-homelab/vitest.config.ts` (or jest) | Modify | Add `integration` project with longer timeout + `kind` precondition skip |
| `plugins/autonomous-dev-homelab/.github/workflows/test.yml` | Modify | Run integration suite on a job that has Docker + kind installed |

## Implementation Details

### Per-probe coverage audit

`coverage.audit.test.ts` (a guard test, not new functionality):

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROBES = [
  "k8s", "docker", "proxmox", "unifi", "zfs", "smart",
  "cert-expiry", "backup-overdue", "daemon-heartbeat",
];

describe("probe coverage thresholds", () => {
  const summary = JSON.parse(
    readFileSync(join(__dirname, "../../../coverage/coverage-summary.json"), "utf8"),
  ) as Record<string, { statements: { pct: number }; branches: { pct: number } }>;

  test.each(PROBES)("%s probe ≥90%% statements + ≥85%% branches", (probe) => {
    const key = Object.keys(summary).find((k) => k.endsWith(`/probes/${probe}.ts`));
    if (!key) throw new Error(`no coverage entry for ${probe}.ts`);
    expect(summary[key].statements.pct).toBeGreaterThanOrEqual(90);
    expect(summary[key].branches.pct).toBeGreaterThanOrEqual(85);
  });
});
```

This test is run AFTER the main suite produces a coverage report, in the same CI job. Failure means a probe regressed below threshold.

### Collector + promoter flow integration

`collector-promoter-flow.test.ts` exercises the full assembly without external services:

- Construct a fake `Probe` that emits a known observation list per call.
- Wire it into the real `ObservationCollector` with the real `DedupCache`, `ObservationStore` (pointing at a tmp dir), and `ObservationPromoter` (with a mocked `execFile`).
- Call `runProbe(fakeProbe)` twice in succession, assert: 1st call → save + promote happen; 2nd call → both suppressed.
- Advance fake time by 1h + 1ms, call again, assert save + promote happen again.
- Verify on-disk artifacts match expectations (`<dataDir>/observations/<id>.json` exists, JSON parses, schema-valid).

### K8s end-to-end integration

`tests/integration/helpers/kind-cluster.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export const KIND_CLUSTER_NAME = "homelab-spec-002-1-05";

export async function setupKind(): Promise<{ kubeconfig: string }> {
  await exec("kind", ["create", "cluster", "--name", KIND_CLUSTER_NAME, "--wait", "60s"]);
  const { stdout } = await exec("kind", ["get", "kubeconfig", "--name", KIND_CLUSTER_NAME]);
  // Write to a tmp file and return its path
  // ...
}

export async function teardownKind(): Promise<void> {
  await exec("kind", ["delete", "cluster", "--name", KIND_CLUSTER_NAME]);
}

export async function isKindAvailable(): Promise<boolean> {
  try {
    await exec("kind", ["version"]);
    await exec("docker", ["info"]);
    return true;
  } catch { return false; }
}
```

`tests/integration/fixtures/k8s-crashloop-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: crashloop-test
  namespace: default
spec:
  restartPolicy: Always
  containers:
    - name: looper
      image: busybox:1.36
      command: ["sh", "-c", "echo 'crashing'; exit 1"]
```

`tests/integration/helpers/mock-autonomous-dev.ts`:

```typescript
import { writeFile, chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a tmp dir containing a fake `autonomous-dev` shim that appends every invocation to a log file. */
export async function makeMockAutonomousDev(): Promise<{ binDir: string; logFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mock-ad-"));
  const logFile = join(dir, "invocations.log");
  const bin = join(dir, "autonomous-dev");
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`;
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { binDir: dir, logFile };
}
```

`tests/integration/test-k8s-observation.test.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { setupKind, teardownKind, isKindAvailable } from "./helpers/kind-cluster.js";
import { makeMockAutonomousDev } from "./helpers/mock-autonomous-dev.js";
import { K8sConnection } from "../../src/connection/k8s.js";
import { K8sProbe } from "../../src/observation/probes/k8s.js";
import { ObservationCollector } from "../../src/observation/collector.js";
import { ObservationPromoter } from "../../src/observation/promoter.js";
import { ObservationStore } from "../../src/observation/persistence.js";
import { DedupCache } from "../../src/observation/dedup.js";

const itIfKind = (await isKindAvailable()) ? it : it.skip;

describe("K8s observation end-to-end", () => {
  let kubeconfig: string;
  let mockBin: { binDir: string; logFile: string };
  let dataDir: string;

  beforeAll(async () => {
    ({ kubeconfig } = await setupKind());
    mockBin = await makeMockAutonomousDev();
    dataDir = /* mkdtemp */;
    await /* kubectl apply -f fixtures/k8s-crashloop-pod.yaml */;
    await /* poll until pod hits CrashLoopBackOff (max 60s) */;
  }, 120_000);

  afterAll(async () => {
    await teardownKind();
  }, 60_000);

  itIfKind("detects crashloop, persists observation, promotes once, dedups second scan", async () => {
    const conn = new K8sConnection({ kubeconfig, platformId: "kind-spec-005" });
    const probe = new K8sProbe(conn);
    const store = new ObservationStore(dataDir);
    const dedup = new DedupCache();
    const promoter = new ObservationPromoter(`${mockBin.binDir}/autonomous-dev`, "homelab");
    const collector = new ObservationCollector([probe], dedup, store, promoter);

    const first = await collector.runProbe(probe);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0].pattern).toBe("crash_loop");
    expect(first[0].resource).toMatch(/^Pod\/crashloop-test/);

    const persisted = await store.list();
    expect(persisted.length).toBe(first.length);

    const log = await readFile(mockBin.logFile, "utf8");
    expect(log).toContain("request submit");
    expect(log).toContain("--type bug");
    expect(log).toContain("--source production-intelligence");

    const second = await collector.runProbe(probe);
    expect(second.length).toBe(0); // dedup suppresses

    const log2 = await readFile(mockBin.logFile, "utf8");
    expect(log2).toBe(log); // no new invocation
  }, 60_000);
});
```

## Acceptance Criteria

**Coverage audit**
- [ ] `coverage.audit.test.ts` passes when every probe in `PROBES` has ≥90% statement and ≥85% branch coverage.
- [ ] If any probe is missing from the coverage report (e.g. file renamed, test missing), the audit fails with a clear "no coverage entry" message.

**Collector + promoter flow**
- [ ] First call to `runProbe` for a fresh observation persists the file AND records 1 invocation against the mocked execFile.
- [ ] Second call within the dedup window persists nothing AND records 0 additional invocations.
- [ ] After advancing fake time by `>1h`, the same observation is treated as new: persisted + promoted once more.
- [ ] On-disk observation files validate against `observation-v1.json` (using `ajv` in the test).
- [ ] Mocked `execFile` receives `["request", "submit", "--type", "bug", "--source", "production-intelligence", "--repo", "homelab", "--description", <string>, "--metadata", <JSON>]` for the test observation.

**K8s integration**
- [ ] `kind create cluster` succeeds within 60s; teardown succeeds within 60s.
- [ ] If `kind` or `docker` is not on PATH, the integration test is SKIPPED (not failed) — verified by `isKindAvailable()` returning false.
- [ ] Crashlooping pod reaches `CrashLoopBackOff` state within 60s of apply (poll loop).
- [ ] First `K8sProbe.scan()` via the collector returns ≥1 observation with `pattern === "crash_loop"` and `resource` matching `Pod/crashloop-test/.../`.
- [ ] Persisted observation file exists at `<dataDir>/observations/<id>.json` and is schema-valid.
- [ ] Mock `autonomous-dev` log contains exactly 1 invocation with the expected args.
- [ ] Second `runProbe` call returns `[]` and produces NO additional log lines (dedup proven end-to-end).
- [ ] Test cleans up: kind cluster deleted, tmp dirs removed, even on failure (use `afterAll` + `try/finally`).

**CI wiring**
- [ ] Integration job runs only on Linux runners with Docker; the mac/windows matrix skips it.
- [ ] Integration job timeout is set to ≥10 minutes.
- [ ] Integration job failures do NOT block the default test job (separate workflow check), so transient kind/docker flakes can be re-run independently.

## Dependencies

- SPEC-002-1-01 through SPEC-002-1-04: all production code under test.
- `kind` ≥0.20 and `docker` (provided by GitHub Actions `ubuntu-latest` runners with `docker/setup-docker-action` if not already).
- `ajv` (already a dev dep).
- Test runner: vitest (or jest, whichever the plugin uses) — must support fake timers AND multi-project config for separating unit vs integration suites.

## Notes

- The kind cluster is created ONCE per test file (`beforeAll`), not per test, to keep wall time under 2 minutes. The single test inside is a multi-step end-to-end check; do not split into separate `it` blocks (each would re-create the cluster).
- `mockBin.logFile` is a simple append-only file because we only need to verify invocation count and arg shape — not full structured parsing. If future tests need richer assertions, swap to a Node script that JSON-encodes args.
- The crashloop pod uses `busybox:1.36` (small, fast pull). If runner network is restricted, swap to a registry mirror via kind config; document in the helper.
- Per the PLAN risks row on K8s version drift: the integration test runs against whatever K8s version `kind` defaults to. We do NOT pin a version here — kind's defaults track stable. If a probe assumption breaks for an older cluster, the per-probe unit fixtures (1.22/1.25/1.28) are the canary.
- The mock `autonomous-dev` shim deliberately exits 0 always; tests for promoter failure modes (non-zero exit) live in the unit tests under SPEC-002-1-04, not here.
- Coverage thresholds (≥90% statement, ≥85% branch) are tighter than the plan's "≥90%" because the gap between the two metrics is where untested error branches hide. If a probe legitimately can't reach 85% branches (e.g. a defensive `unreachable()` arm), document the inline `/* c8 ignore next */` rather than lower the threshold.
- Definition-of-done for PLAN-002-1 lists "Audit entries emitted for every observation and promotion" — that's verified inside SPEC-002-1-04's collector tests (audit writer mock); this spec doesn't re-test it.
