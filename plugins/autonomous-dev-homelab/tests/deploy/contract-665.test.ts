/**
 * Tests for Issue #665 — daemon deploy-phase target handoff.
 *
 * Coverage:
 *   - DeploymentRecord gains targetId, location, node fields
 *   - HMAC covers the new fields (tamper test on each new field)
 *   - orchestrateContractDeploy branches on location correctly:
 *       cloud → dispatchCloud (unchanged path)
 *       homelab → dispatchHomelab (delegate to plugin gate)
 *   - Homelab dispatch does NOT reimplement the gate — it calls the injected
 *     dispatchHomelab function and passes the context through
 *   - DeploymentRecord is signed covering all new fields
 *
 * These are WIRING tests — the orchestrator actually reads location and
 * branches; the HMAC tamper test proves the new fields are covered.
 */

import {
  signDeploymentRecord,
  verifyDeploymentRecord,
} from "../../src/deploy/sign-record";
import type {
  DeploymentRecordPayload,
  DeploymentRecord,
} from "../../src/deploy/types";
import {
  orchestrateContractDeploy,
  type ContractOrchestrationDeps,
} from "../../src/deploy/contract-orchestrator";
import {
  BACKUP_CLASS,
  type DeployContractRequest,
  type ResolvedContractTarget,
} from "../../src/deploy/contract";
import { ensureHmacSecret } from "../helpers/hmac-secret";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePayload(
  overrides?: Partial<DeploymentRecordPayload>,
): DeploymentRecordPayload {
  return {
    id: "ulid-665-test",
    backendName: "docker-swarm",
    target: "homelab-docker-swarm",
    envName: "prod",
    artifactLocation: "sha256:abc123",
    details: { stack_name: "myapp" },
    deployedAt: "2026-01-01T00:00:00.000Z",
    // New fields from #665:
    targetId: "target-swarm-01",
    location: "homelab",
    node: "swarm-manager-01",
    ...overrides,
  };
}

const HOMELAB_TARGET: ResolvedContractTarget = {
  id: "target-swarm-homelab",
  location: "homelab",
  capabilities: [],
  backup_class: BACKUP_CLASS.none,
  tags: ["role:reverse-proxy"],
};

const CLOUD_TARGET: ResolvedContractTarget = {
  id: "target-k8s-cloud",
  location: "cloud",
  capabilities: [],
  backup_class: BACKUP_CLASS.none,
  tags: ["role:api"],
};

function makeRequest(
  target: ResolvedContractTarget,
  overrides?: Partial<DeployContractRequest>,
): DeployContractRequest {
  return {
    requestId: "req-665-test",
    envName: "prod",
    commitSha: "cafebabe",
    target,
    requiresVerifiedBackup: false,
    backupOverride: false,
    ...overrides,
  };
}

function makeDeps(
  overrides?: Partial<ContractOrchestrationDeps>,
): ContractOrchestrationDeps {
  return {
    dispatchCloud: jest.fn().mockResolvedValue({ location: "cloud", ok: true }),
    dispatchHomelab: jest
      .fn()
      .mockResolvedValue({ location: "homelab", ok: true }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DeploymentRecord new fields
// ---------------------------------------------------------------------------

describe("DeploymentRecordPayload — new fields from #665", () => {
  beforeAll(() => {
    ensureHmacSecret();
  });

  it("accepts targetId field", () => {
    const payload = makePayload({ targetId: "tgt-01" });
    expect(payload.targetId).toBe("tgt-01");
  });

  it('accepts location field ("homelab")', () => {
    const payload = makePayload({ location: "homelab" });
    expect(payload.location).toBe("homelab");
  });

  it('accepts location field ("cloud")', () => {
    const payload = makePayload({ location: "cloud" });
    expect(payload.location).toBe("cloud");
  });

  it("accepts node field", () => {
    const payload = makePayload({ node: "swarm-manager-01" });
    expect(payload.node).toBe("swarm-manager-01");
  });

  it("node field is optional", () => {
    const payload = makePayload();
    delete payload.node;
    expect(payload.node).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HMAC covers new fields — tamper tests
// ---------------------------------------------------------------------------

describe("HMAC covers new DeploymentRecord fields (#665)", () => {
  beforeAll(() => {
    ensureHmacSecret();
  });

  it("signed record verifies with all new fields present", () => {
    const record = signDeploymentRecord(makePayload());
    expect(verifyDeploymentRecord(record)).toBe(true);
  });

  it("tampered targetId is rejected by HMAC", () => {
    const record = signDeploymentRecord(
      makePayload({ targetId: "original-target" }),
    );
    const tampered: DeploymentRecord = {
      payload: { ...record.payload, targetId: "tampered-target" },
      hmac: record.hmac,
    };
    expect(verifyDeploymentRecord(tampered)).toBe(false);
  });

  it("tampered location is rejected by HMAC", () => {
    const record = signDeploymentRecord(makePayload({ location: "homelab" }));
    const tampered: DeploymentRecord = {
      payload: { ...record.payload, location: "cloud" },
      hmac: record.hmac,
    };
    expect(verifyDeploymentRecord(tampered)).toBe(false);
  });

  it("tampered node is rejected by HMAC", () => {
    const record = signDeploymentRecord(makePayload({ node: "legit-node" }));
    const tampered: DeploymentRecord = {
      payload: { ...record.payload, node: "attacker-node" },
      hmac: record.hmac,
    };
    expect(verifyDeploymentRecord(tampered)).toBe(false);
  });

  it("adding targetId to a payload-without-it changes the HMAC", () => {
    const withoutTargetId = makePayload();
    delete withoutTargetId.targetId;
    const withTargetId = makePayload({ targetId: "injected-target" });

    const sigWithout = signDeploymentRecord(withoutTargetId);
    const sigWith = signDeploymentRecord(withTargetId);
    expect(sigWith.hmac).not.toBe(sigWithout.hmac);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator location branch — wiring test
// ---------------------------------------------------------------------------

describe("orchestrateContractDeploy — location branch (#665)", () => {
  beforeAll(() => {
    ensureHmacSecret();
  });

  it("homelab target → calls dispatchHomelab, NOT dispatchCloud", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(
      makeRequest(HOMELAB_TARGET),
      deps,
    );
    expect(result.status).toBe("dispatched");
    expect(result.location).toBe("homelab");
    expect(deps.dispatchHomelab).toHaveBeenCalledTimes(1);
    expect(deps.dispatchCloud).not.toHaveBeenCalled();
  });

  it("cloud target → calls dispatchCloud, NOT dispatchHomelab", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(
      makeRequest(CLOUD_TARGET),
      deps,
    );
    expect(result.status).toBe("dispatched");
    expect(result.location).toBe("cloud");
    expect(deps.dispatchCloud).toHaveBeenCalledTimes(1);
    expect(deps.dispatchHomelab).not.toHaveBeenCalled();
  });

  it("homelab dispatch receives the full request in context", async () => {
    const deps = makeDeps();
    const request = makeRequest(HOMELAB_TARGET);
    await orchestrateContractDeploy(request, deps);
    const callArgs = (deps.dispatchHomelab as jest.Mock).mock.calls[0] as [
      { request: DeployContractRequest },
    ];
    expect(callArgs[0].request).toBe(request);
  });

  it("cloud dispatch receives the full request in context", async () => {
    const deps = makeDeps();
    const request = makeRequest(CLOUD_TARGET);
    await orchestrateContractDeploy(request, deps);
    const callArgs = (deps.dispatchCloud as jest.Mock).mock.calls[0] as [
      { request: DeployContractRequest },
    ];
    expect(callArgs[0].request).toBe(request);
  });

  it("homelab dispatch context does NOT include plugin gate implementation", async () => {
    // Core delegates to the plugin — the context carries the request but
    // does NOT include any typed-CONFIRM or 24h delay implementation.
    const deps = makeDeps();
    await orchestrateContractDeploy(makeRequest(HOMELAB_TARGET), deps);
    const callArgs = (deps.dispatchHomelab as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
    ];
    const ctx = callArgs[0];
    // The gate itself is not in the context — delegation is via the function call.
    expect(ctx).not.toHaveProperty("gate");
    expect(ctx).not.toHaveProperty("typedConfirm");
    expect(ctx).not.toHaveProperty("delay");
  });

  it("dispatchResult is returned in orchestration result", async () => {
    const expectedResult = { location: "homelab", pendingActionId: "ulid-abc" };
    const deps = makeDeps({
      dispatchHomelab: jest.fn().mockResolvedValue(expectedResult),
    });
    const result = await orchestrateContractDeploy(
      makeRequest(HOMELAB_TARGET),
      deps,
    );
    expect(result.dispatchResult).toEqual(expectedResult);
  });

  it("cloud path result is unchanged (cloud path unaffected by #665)", async () => {
    const expectedResult = { location: "cloud", jobId: "gcp-job-xyz" };
    const deps = makeDeps({
      dispatchCloud: jest.fn().mockResolvedValue(expectedResult),
    });
    const result = await orchestrateContractDeploy(
      makeRequest(CLOUD_TARGET),
      deps,
    );
    expect(result.dispatchResult).toEqual(expectedResult);
    expect(result.status).toBe("dispatched");
  });
});
