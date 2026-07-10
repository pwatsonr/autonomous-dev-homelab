/**
 * Tests for Issue #681 — wire real action execution behind the gate.
 *
 * Covers:
 *   (a) apply-autofix handler shells out to `autofix apply <proposal>` with
 *       CONFIRM piped on stdin ONLY after gate passes (typed-CONFIRM IS the
 *       confirmation — no double-prompt).
 *   (b) Gate-required: the action is blocked when the gate is not passed.
 *   (c) Destructiveness is `destructive` (maps to `reversible` or higher).
 *   (d) Full audit logging on action invocation + outcome.
 *   (e) restart action calls the platform API path (not CLI).
 *   (f) scale action calls the platform API path.
 *   (g) CLI is invoked via subprocess (mock child_process.spawn) — assert
 *       argv contains proposal id + CONFIRM is piped on stdin.
 *
 * Safety model: child_process.spawn is mocked; gate is mocked via
 *   jest.fn() injection; real audit writer stub records events.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  GatedActionPortalContrib,
  type GatedActionDeps,
  type GatedActionResult,
  type GateAction,
  type GateApprovalResult,
} from "../../src/portal/contrib/gated-actions-contrib";
import type { PortalContribRequest } from "../../src/portal/contrib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "gated-actions-test-"));
}

type AuditEntry = { event: string; payload: Record<string, unknown> };

function makeAuditStub(): {
  entries: AuditEntry[];
  write: GatedActionDeps["audit"];
} {
  const entries: AuditEntry[] = [];
  return {
    entries,
    write: jest.fn(async (event: string, payload: Record<string, unknown>) => {
      entries.push({ event, payload });
    }),
  };
}

/**
 * Builds a mock subprocess factory that records calls and optionally
 * returns a specific exit code / stdout.
 */
function makeSubprocessMock(
  exitCode = 0,
  stdout = "ok",
): {
  spawn: GatedActionDeps["spawn"];
  calls: Array<{ cmd: string; args: string[]; stdinData: string }>;
} {
  const calls: Array<{ cmd: string; args: string[]; stdinData: string }> = [];
  const spawn: GatedActionDeps["spawn"] = (cmd, args, stdinData) => {
    calls.push({ cmd, args, stdinData });
    return Promise.resolve({ exitCode, stdout, stderr: "" });
  };
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// apply-autofix action
// ---------------------------------------------------------------------------

describe("GatedActionPortalContrib — apply-autofix", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("shells out to `homelab autofix apply <proposal>` with CONFIRM on stdin after gate approval", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(0);
    // Gate mock: immediately approves (simulates typed-CONFIRM already passed in portal).
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-001",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const req: PortalContribRequest = {
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    };

    const result = await contrib.route(req);
    expect(result.status).toBe(200);
    const json = JSON.parse(result.body) as GatedActionResult;
    expect(json.ok).toBe(true);

    // Assert the subprocess was invoked with correct args.
    expect(subproc.calls).toHaveLength(1);
    const call = subproc.calls[0];
    expect(call?.cmd).toBe("/usr/local/bin/homelab");
    expect(call?.args).toEqual([
      "autofix",
      "apply",
      "prop-2024-01-01-abcd1234",
    ]);
    // CONFIRM must be piped on stdin — the portal gate IS the confirmation.
    expect(call?.stdinData).toBe("CONFIRM\n");
  });

  it("gate is REQUIRED — action does NOT execute when gate is not called first", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(0);
    // Gate mock: denies (operator rejected in portal).
    const gate = jest.fn(async () => {
      throw new Error("gate denied: typed-CONFIRM rejected");
    });

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const req: PortalContribRequest = {
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    };

    const result = await contrib.route(req);
    // Gate denial must return a non-2xx status.
    expect(result.status).toBeGreaterThanOrEqual(400);
    // Subprocess must NOT have been called.
    expect(subproc.calls).toHaveLength(0);
  });

  it("gate is always called before subprocess — gate call precedes spawn call", async () => {
    const callOrder: string[] = [];
    const auditStub = makeAuditStub();

    const gate = jest.fn(async () => {
      callOrder.push("gate");
      return {
        approved: true as const,
        actionId: "act-002",
        approvedAt: "",
        approvedBy: "portal",
      };
    });
    const spawnFn: GatedActionDeps["spawn"] = async (cmd, args, stdinData) => {
      callOrder.push("spawn");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: spawnFn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    await contrib.route({
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    });

    expect(callOrder).toEqual(["gate", "spawn"]);
  });

  it("action has destructiveness=destructive in the gate payload", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(0);
    let capturedAction: GateAction | undefined;
    const gate = jest.fn(
      async (action: GateAction): Promise<GateApprovalResult> => {
        capturedAction = action;
        return {
          approved: true as const,
          actionId: "act-003",
          approvedAt: "",
          approvedBy: "portal",
        };
      },
    );

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    await contrib.route({
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    });

    expect(capturedAction).toBeDefined();
    // destructiveness must be destructive (reversible or higher in our ladder)
    expect(capturedAction?.destructiveness).toMatch(
      /reversible|persistent-modifying|data-affecting|architectural/,
    );
  });

  it("writes audit record BEFORE and AFTER action invocation", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(0);
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-004",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    await contrib.route({
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    });

    // Must have at least 2 audit entries: initiation + completion.
    expect(auditStub.entries.length).toBeGreaterThanOrEqual(2);
    // The proposal id must appear in the audit payload.
    const hasProposalId = auditStub.entries.some(
      (e) => e.payload["proposalId"] === "prop-2024-01-01-abcd1234",
    );
    expect(hasProposalId).toBe(true);
  });

  it("returns error when subprocess exits non-zero", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(1, "");
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-005",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { proposalId: "prop-2024-01-01-abcd1234", requestedBy: "operator" },
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    const json = JSON.parse(result.body) as GatedActionResult;
    expect(json.ok).toBe(false);
  });

  it("missing proposalId returns 400", async () => {
    const auditStub = makeAuditStub();
    const subproc = makeSubprocessMock(0);
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-006",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: subproc.spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/apply-autofix",
      query: {},
      body: { requestedBy: "operator" },
    });

    expect(result.status).toBe(400);
    expect(subproc.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// restart action via platform API
// ---------------------------------------------------------------------------

describe("GatedActionPortalContrib — restart", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("restart action calls platform API path (not homelab CLI)", async () => {
    const auditStub = makeAuditStub();
    const platformApiCalls: Array<{
      action: string;
      params: Record<string, unknown>;
    }> = [];

    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-r1",
      approvedAt: "",
      approvedBy: "portal",
    }));
    const platformApi: GatedActionDeps["platformApi"] = async (
      action,
      params,
    ) => {
      platformApiCalls.push({ action, params });
      return { ok: true };
    };

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/restart",
      query: {},
      body: {
        service: "nginx",
        platform: "docker-swarm",
        requestedBy: "operator",
      },
    });

    expect(result.status).toBe(200);
    expect(platformApiCalls).toHaveLength(1);
    expect(platformApiCalls[0]?.action).toBe("restart");
    expect(platformApiCalls[0]?.params["service"]).toBe("nginx");
  });

  it("restart writes audit records including service name", async () => {
    const auditStub = makeAuditStub();
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-r2",
      approvedAt: "",
      approvedBy: "portal",
    }));
    const platformApi: GatedActionDeps["platformApi"] = async () => ({
      ok: true,
    });

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    await contrib.route({
      method: "POST",
      pathname: "/portal/actions/restart",
      query: {},
      body: {
        service: "redis",
        platform: "docker-swarm",
        requestedBy: "operator",
      },
    });

    const hasService = auditStub.entries.some(
      (e) => e.payload["service"] === "redis",
    );
    expect(hasService).toBe(true);
  });

  it("restart is gated — blocked when gate denies", async () => {
    const auditStub = makeAuditStub();
    const platformApiCalls: Array<unknown> = [];
    const gate = jest.fn(async () => {
      throw new Error("gate denied");
    });
    const platformApi: GatedActionDeps["platformApi"] = async () => {
      platformApiCalls.push({});
      return { ok: true };
    };

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/restart",
      query: {},
      body: {
        service: "nginx",
        platform: "docker-swarm",
        requestedBy: "operator",
      },
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(platformApiCalls).toHaveLength(0);
  });

  it("restart missing service returns 400", async () => {
    const auditStub = makeAuditStub();
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-r3",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/restart",
      query: {},
      body: { platform: "docker-swarm", requestedBy: "operator" },
    });

    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// scale action via platform API
// ---------------------------------------------------------------------------

describe("GatedActionPortalContrib — scale", () => {
  it("scale action calls platform API with replicas param", async () => {
    const auditStub = makeAuditStub();
    const platformApiCalls: Array<{
      action: string;
      params: Record<string, unknown>;
    }> = [];

    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-s1",
      approvedAt: "",
      approvedBy: "portal",
    }));
    const platformApi: GatedActionDeps["platformApi"] = async (
      action,
      params,
    ) => {
      platformApiCalls.push({ action, params });
      return { ok: true };
    };

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/scale",
      query: {},
      body: {
        service: "api",
        replicas: 3,
        platform: "k3s",
        requestedBy: "operator",
      },
    });

    expect(result.status).toBe(200);
    expect(platformApiCalls).toHaveLength(1);
    expect(platformApiCalls[0]?.action).toBe("scale");
    expect(platformApiCalls[0]?.params["replicas"]).toBe(3);
    expect(platformApiCalls[0]?.params["service"]).toBe("api");
  });

  it("scale is gated — blocked when gate denies", async () => {
    const auditStub = makeAuditStub();
    const platformApiCalls: Array<unknown> = [];
    const gate = jest.fn(async () => {
      throw new Error("gate denied");
    });
    const platformApi: GatedActionDeps["platformApi"] = async () => {
      platformApiCalls.push({});
      return { ok: true };
    };

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/scale",
      query: {},
      body: {
        service: "api",
        replicas: 3,
        platform: "k3s",
        requestedBy: "operator",
      },
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(platformApiCalls).toHaveLength(0);
  });

  it("scale writes audit record with replicas", async () => {
    const auditStub = makeAuditStub();
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-s2",
      approvedAt: "",
      approvedBy: "portal",
    }));
    const platformApi: GatedActionDeps["platformApi"] = async () => ({
      ok: true,
    });

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
      platformApi,
    });

    await contrib.route({
      method: "POST",
      pathname: "/portal/actions/scale",
      query: {},
      body: {
        service: "worker",
        replicas: 5,
        platform: "k3s",
        requestedBy: "operator",
      },
    });

    const hasReplicas = auditStub.entries.some(
      (e) => e.payload["replicas"] === 5,
    );
    expect(hasReplicas).toBe(true);
  });

  it("scale missing replicas returns 400", async () => {
    const auditStub = makeAuditStub();
    const gate = jest.fn(async () => ({
      approved: true as const,
      actionId: "act-s3",
      approvedAt: "",
      approvedBy: "portal",
    }));

    const contrib = new GatedActionPortalContrib({
      audit: auditStub.write,
      spawn: makeSubprocessMock(0).spawn,
      gate,
      homelabBin: "/usr/local/bin/homelab",
    });

    const result = await contrib.route({
      method: "POST",
      pathname: "/portal/actions/scale",
      query: {},
      body: { service: "api", platform: "k3s", requestedBy: "operator" },
    });

    expect(result.status).toBe(400);
  });
});
