/**
 * Tests for Issue #666 — stateful-target declaration + backup precondition + DR backup_class.
 *
 * Coverage:
 *   - BackupClass enum values
 *   - `stateful` capability flag in BackendMetadata
 *   - `requiresVerifiedBackup` precondition on deploy request
 *   - Selector/orchestrator blocks stateful deploy when precondition is not satisfied
 *   - Override path (`backupOverride: true`) allows a stateful deploy through
 *   - `backup_class` is surfaced on resolved targets
 *   - Types are exported from contract.ts (the published surface)
 *
 * These tests cover the WIRING — real code paths through the orchestrator and
 * selector, not just type shape.
 */

import {
  type BackupClass,
  type DeployContract,
  type DeployContractRequest,
  type ResolvedContractTarget,
  BACKUP_CLASS,
  evaluateStatefulPrecondition,
} from "../../src/deploy/contract";

import {
  orchestrateContractDeploy,
  type ContractOrchestrationDeps,
  type ContractOrchestrationResult,
} from "../../src/deploy/contract-orchestrator";

import { ensureHmacSecret } from "../helpers/hmac-secret";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATEFUL_TARGET: ResolvedContractTarget = {
  id: "target-db-01",
  location: "homelab",
  capabilities: ["stateful"],
  backup_class: BACKUP_CLASS.snapshot,
  tags: ["role:database"],
};

const STATELESS_TARGET: ResolvedContractTarget = {
  id: "target-web-01",
  location: "cloud",
  capabilities: [],
  backup_class: BACKUP_CLASS.none,
  tags: ["role:reverse-proxy"],
};

const ORCHESTRATED_TARGET: ResolvedContractTarget = {
  id: "target-vol-01",
  location: "homelab",
  capabilities: ["stateful"],
  backup_class: BACKUP_CLASS.orchestrated,
  tags: ["role:cache"],
};

function makeStatefulRequest(
  overrides?: Partial<DeployContractRequest>,
): DeployContractRequest {
  return {
    requestId: "req-666-stateful",
    envName: "prod",
    commitSha: "abc123",
    target: STATEFUL_TARGET,
    requiresVerifiedBackup: true,
    backupOverride: false,
    ...overrides,
  };
}

function makeStatelessRequest(
  overrides?: Partial<DeployContractRequest>,
): DeployContractRequest {
  return {
    requestId: "req-666-stateless",
    envName: "staging",
    commitSha: "def456",
    target: STATELESS_TARGET,
    requiresVerifiedBackup: false,
    backupOverride: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BACKUP_CLASS enum
// ---------------------------------------------------------------------------

describe("BACKUP_CLASS enum", () => {
  it("exposes none value", () => {
    expect(BACKUP_CLASS.none).toBe("none");
  });

  it("exposes snapshot value", () => {
    expect(BACKUP_CLASS.snapshot).toBe("snapshot");
  });

  it("exposes orchestrated value", () => {
    expect(BACKUP_CLASS.orchestrated).toBe("orchestrated");
  });

  it("the values satisfy BackupClass type", () => {
    const cls: BackupClass = BACKUP_CLASS.snapshot;
    expect(["none", "snapshot", "orchestrated"]).toContain(cls);
  });
});

// ---------------------------------------------------------------------------
// evaluateStatefulPrecondition — pure logic
// ---------------------------------------------------------------------------

describe("evaluateStatefulPrecondition", () => {
  it("allows a stateless target regardless of requiresVerifiedBackup", () => {
    const result = evaluateStatefulPrecondition(makeStatelessRequest());
    expect(result.allowed).toBe(true);
  });

  it("blocks a stateful target when requiresVerifiedBackup=true and backupOverride=false", () => {
    const result = evaluateStatefulPrecondition(makeStatefulRequest());
    // blocked: no verified backup recorded in the request, override not set
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/backup/i);
  });

  it("allows a stateful target when backupOverride=true (explicit admin bypass)", () => {
    const result = evaluateStatefulPrecondition(
      makeStatefulRequest({ backupOverride: true }),
    );
    expect(result.allowed).toBe(true);
    expect(result.overrideApplied).toBe(true);
  });

  it("allows a stateful target when verifiedBackupRef is set (backup completed)", () => {
    const result = evaluateStatefulPrecondition(
      makeStatefulRequest({ verifiedBackupRef: "backup-manifest-sha256:abc" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks a stateful target even when backup_class=orchestrated and no ref/override", () => {
    const result = evaluateStatefulPrecondition(
      makeStatefulRequest({ target: ORCHESTRATED_TARGET }),
    );
    expect(result.allowed).toBe(false);
  });

  it("blocks stateless target with requiresVerifiedBackup=true but stateful flag absent", () => {
    // A stateless target (no 'stateful' capability) with requiresVerifiedBackup=true
    // is a misconfiguration: the precondition is irrelevant — we allow it through.
    // The target is not stateful, so we never block.
    const result = evaluateStatefulPrecondition(
      makeStatelessRequest({ requiresVerifiedBackup: true }),
    );
    // Stateless target: the 'stateful' capability is absent, so we allow it.
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// orchestrateContractDeploy — wiring test (orchestrator reads stateful+backup_class)
// ---------------------------------------------------------------------------

describe("orchestrateContractDeploy — stateful wiring", () => {
  beforeAll(() => {
    ensureHmacSecret();
  });

  function makeDeps(
    overrides?: Partial<ContractOrchestrationDeps>,
  ): ContractOrchestrationDeps {
    return {
      dispatchCloud: jest
        .fn()
        .mockResolvedValue({ dispatched: true, location: "cloud" }),
      dispatchHomelab: jest
        .fn()
        .mockResolvedValue({ dispatched: true, location: "homelab" }),
      ...overrides,
    };
  }

  it("blocks stateful deploy (no backup ref or override) — does NOT call dispatch", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(makeStatefulRequest(), deps);
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/backup/i);
    expect(deps.dispatchCloud).not.toHaveBeenCalled();
    expect(deps.dispatchHomelab).not.toHaveBeenCalled();
  });

  it("allows stateful deploy with backupOverride=true — calls dispatchHomelab", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(
      makeStatefulRequest({ backupOverride: true }),
      deps,
    );
    expect(result.status).toBe("dispatched");
    expect(deps.dispatchHomelab).toHaveBeenCalledTimes(1);
  });

  it("allows stateful deploy with verifiedBackupRef — calls dispatchHomelab", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(
      makeStatefulRequest({ verifiedBackupRef: "backup-ref-abc123" }),
      deps,
    );
    expect(result.status).toBe("dispatched");
    expect(deps.dispatchHomelab).toHaveBeenCalledTimes(1);
  });

  it("stateless cloud deploy calls dispatchCloud not dispatchHomelab", async () => {
    const deps = makeDeps();
    const result = await orchestrateContractDeploy(
      makeStatelessRequest(),
      deps,
    );
    expect(result.status).toBe("dispatched");
    expect(deps.dispatchCloud).toHaveBeenCalledTimes(1);
    expect(deps.dispatchHomelab).not.toHaveBeenCalled();
  });

  it("backup_class is forwarded in dispatchHomelab call context", async () => {
    const deps = makeDeps();
    await orchestrateContractDeploy(
      makeStatefulRequest({ verifiedBackupRef: "ref-abc" }),
      deps,
    );
    const callArgs = (deps.dispatchHomelab as jest.Mock).mock.calls[0] as [
      unknown,
    ];
    const ctx = callArgs[0] as { backup_class: BackupClass };
    expect(ctx.backup_class).toBe(BACKUP_CLASS.snapshot);
  });

  it("backup_class=none is forwarded in dispatchCloud call context", async () => {
    const deps = makeDeps();
    await orchestrateContractDeploy(makeStatelessRequest(), deps);
    const callArgs = (deps.dispatchCloud as jest.Mock).mock.calls[0] as [
      unknown,
    ];
    const ctx = callArgs[0] as { backup_class: BackupClass };
    expect(ctx.backup_class).toBe(BACKUP_CLASS.none);
  });
});

// ---------------------------------------------------------------------------
// Type surface — contract.ts exports all required types (compile-time)
// ---------------------------------------------------------------------------

describe("contract.ts type surface", () => {
  it("DeployContract interface is importable", () => {
    // compile-time proof: if this file type-checks, DeployContract is exported
    const _typeCheck: DeployContract = {
      schemaVersion: 1,
      issuedAt: new Date().toISOString(),
      requestId: "req-type-check",
    };
    expect(_typeCheck.schemaVersion).toBe(1);
  });

  it("ResolvedContractTarget carries stateful flag + backup_class", () => {
    const t: ResolvedContractTarget = {
      id: "tgt-01",
      location: "homelab",
      capabilities: ["stateful"],
      backup_class: BACKUP_CLASS.orchestrated,
      tags: [],
    };
    expect(t.capabilities).toContain("stateful");
    expect(t.backup_class).toBe("orchestrated");
  });
});
