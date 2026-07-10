/**
 * Portal contribution for gated action execution (Issue #681).
 *
 * Handles:
 *   POST /portal/actions/apply-autofix  — run `homelab autofix apply <proposal>`
 *                                         with CONFIRM piped on stdin after gate
 *   POST /portal/actions/restart        — restart a service via platform API
 *   POST /portal/actions/scale          — scale a service via platform API
 *
 * Design:
 * - The portal typed-CONFIRM gate IS the human confirmation. The handler
 *   pipes `CONFIRM\n` on stdin to the homelab CLI subprocess so the CLI
 *   safety gate passes without prompting again (no double-prompt).
 * - `destructiveness` is 'reversible' (or higher) — destructive operations
 *   require gate approval; gate is ALWAYS called before the subprocess.
 * - Full audit logging: one record at initiation, one at completion.
 * - The homelab binary path comes from the injected `homelabBin` dep (same
 *   resolution path used by #48/#49 — no hard-coded paths or tokens).
 * - `spawn` and `platformApi` are injected for testability (subprocess mock,
 *   platform API mock).
 *
 * Implements Issue #681.
 */

import type {
  PortalContrib,
  PortalContribRequest,
  PortalContribResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape returned in the JSON body of every action response. */
export interface GatedActionResult {
  ok: boolean;
  actionId: string;
  reason?: string;
  exitCode?: number;
  stdout?: string;
}

/** Result returned by the subprocess factory. */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Result returned by a platform API call. */
export interface PlatformApiResult {
  ok: boolean;
  reason?: string;
}

/**
 * Dependencies injected into GatedActionPortalContrib. All side-effectful
 * operations are injectable so the class is fully unit-testable.
 */
export interface GatedActionDeps {
  /**
   * Audit-event sink. Called with (event, payload) for every gate initiation
   * and completion.
   */
  audit: (event: string, payload: Record<string, unknown>) => Promise<void>;

  /**
   * Subprocess factory. Receives the command, argument list, and data to write
   * to stdin. Returns exit code + stdout + stderr.
   *
   * Production wiring uses Node's `child_process.spawn`; tests inject a mock.
   */
  spawn: (
    cmd: string,
    args: string[],
    stdinData: string,
  ) => Promise<SpawnResult>;

  /**
   * Safety gate. Called with an action descriptor before any mutation.
   * Must resolve on approval or throw on denial.
   *
   * Production wiring calls the homelab `gateApproval` function; the portal
   * typed-CONFIRM step replaces the CLI's stdin prompt.
   */
  gate: (action: GateAction) => Promise<GateApprovalResult>;

  /** Absolute path to the homelab CLI binary. */
  homelabBin: string;

  /**
   * Platform API for restart/scale actions. Optional: if omitted, restart
   * and scale routes return 501.
   */
  platformApi?: (
    action: string,
    params: Record<string, unknown>,
  ) => Promise<PlatformApiResult>;
}

/** Minimal action descriptor passed to the gate. */
export interface GateAction {
  id: string;
  destructiveness:
    "reversible" | "persistent-modifying" | "data-affecting" | "architectural";
  description: string;
  requestedBy: string;
  initiatedAt: string;
}

/** Approval result from the gate. */
export interface GateApprovalResult {
  approved: true;
  actionId: string;
  approvedAt: string;
  approvedBy: string;
}

// ---------------------------------------------------------------------------
// Contrib implementation
// ---------------------------------------------------------------------------

/**
 * Portal contribution that executes gated actions behind the portal's
 * typed-CONFIRM gate.
 */
export class GatedActionPortalContrib implements PortalContrib {
  private readonly audit: GatedActionDeps["audit"];
  private readonly spawn: GatedActionDeps["spawn"];
  private readonly gate: GatedActionDeps["gate"];
  private readonly homelabBin: string;
  private readonly platformApi: GatedActionDeps["platformApi"];

  constructor(deps: GatedActionDeps) {
    this.audit = deps.audit;
    this.spawn = deps.spawn;
    this.gate = deps.gate;
    this.homelabBin = deps.homelabBin;
    this.platformApi = deps.platformApi;
  }

  async route(req: PortalContribRequest): Promise<PortalContribResponse> {
    const { method, pathname } = req;

    if (method === "POST" && pathname === "/portal/actions/apply-autofix") {
      return this.handleApplyAutofix(req.body);
    }

    if (method === "POST" && pathname === "/portal/actions/restart") {
      return this.handleRestart(req.body);
    }

    if (method === "POST" && pathname === "/portal/actions/scale") {
      return this.handleScale(req.body);
    }

    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "not found",
    };
  }

  // ---------------------------------------------------------------------------
  // POST /portal/actions/apply-autofix
  // ---------------------------------------------------------------------------

  /**
   * Execute `homelab autofix apply <proposalId>` with `CONFIRM\n` piped on
   * stdin. The portal typed-CONFIRM gate IS the human confirmation — do not
   * re-prompt.
   *
   * Gate must be called and must approve before the subprocess is invoked.
   */
  private async handleApplyAutofix(
    body: Record<string, unknown> | null,
  ): Promise<PortalContribResponse> {
    if (body === null) {
      return this.jsonError(400, "request body is required");
    }

    const proposalId = body["proposalId"];
    const requestedBy = body["requestedBy"];

    if (typeof proposalId !== "string" || proposalId === "") {
      return this.jsonError(
        400,
        "proposalId is required and must be a non-empty string",
      );
    }
    if (typeof requestedBy !== "string" || requestedBy === "") {
      return this.jsonError(
        400,
        "requestedBy is required and must be a non-empty string",
      );
    }

    const actionId = `act-autofix-portal-${Date.now().toString(36)}`;
    const initiatedAt = new Date().toISOString();

    // Audit: action initiation.
    await this.audit("portal.action.initiated", {
      actionId,
      actionType: "apply-autofix",
      proposalId,
      requestedBy,
      destructiveness: "reversible",
      initiatedAt,
    });

    // Build the gate action descriptor.
    const gateAction: GateAction = {
      id: actionId,
      destructiveness: "reversible",
      description: `Apply autofix proposal ${proposalId} (portal-triggered)`,
      requestedBy: String(requestedBy),
      initiatedAt,
    };

    // Step 1: Gate approval (MUST come before subprocess).
    let approval: GateApprovalResult;
    try {
      approval = await this.gate(gateAction);
    } catch (err) {
      await this.audit("portal.action.gate-denied", {
        actionId,
        actionType: "apply-autofix",
        proposalId,
        requestedBy,
        reason: (err as Error).message,
        occurredAt: new Date().toISOString(),
      });
      return {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: `gate denied: ${(err as Error).message}`,
        } satisfies GatedActionResult),
      };
    }

    // Step 2: Execute the real homelab CLI subprocess.
    // The portal gate IS the confirmation; pipe CONFIRM\n on stdin so the CLI
    // safety gate passes without prompting the operator a second time.
    let spawnResult: SpawnResult;
    try {
      spawnResult = await this.spawn(
        this.homelabBin,
        ["autofix", "apply", proposalId],
        "CONFIRM\n",
      );
    } catch (err) {
      await this.audit("portal.action.spawn-failed", {
        actionId,
        actionType: "apply-autofix",
        proposalId,
        error: (err as Error).message,
        occurredAt: new Date().toISOString(),
      });
      return {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: `subprocess failed to start: ${(err as Error).message}`,
        } satisfies GatedActionResult),
      };
    }

    // Audit: action completion with exit code.
    await this.audit("portal.action.completed", {
      actionId,
      actionType: "apply-autofix",
      proposalId,
      requestedBy,
      exitCode: spawnResult.exitCode,
      stdoutTail: spawnResult.stdout.slice(-500),
      approvedBy: approval.approvedBy,
      occurredAt: new Date().toISOString(),
    });

    if (spawnResult.exitCode !== 0) {
      return {
        status: 422,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          exitCode: spawnResult.exitCode,
          reason: `autofix apply exited with code ${spawnResult.exitCode}`,
        } satisfies GatedActionResult),
      };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        actionId,
        exitCode: 0,
        stdout: spawnResult.stdout,
      } satisfies GatedActionResult),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /portal/actions/restart
  // ---------------------------------------------------------------------------

  /**
   * Restart a service via the platform API. Gate approval required.
   */
  private async handleRestart(
    body: Record<string, unknown> | null,
  ): Promise<PortalContribResponse> {
    if (body === null) {
      return this.jsonError(400, "request body is required");
    }

    const service = body["service"];
    const platform = body["platform"];
    const requestedBy = body["requestedBy"];

    if (typeof service !== "string" || service === "") {
      return this.jsonError(
        400,
        "service is required and must be a non-empty string",
      );
    }
    if (typeof platform !== "string" || platform === "") {
      return this.jsonError(
        400,
        "platform is required and must be a non-empty string",
      );
    }
    if (typeof requestedBy !== "string" || requestedBy === "") {
      return this.jsonError(
        400,
        "requestedBy is required and must be a non-empty string",
      );
    }

    if (this.platformApi === undefined) {
      return this.jsonError(501, "platformApi not configured");
    }

    const actionId = `act-restart-portal-${Date.now().toString(36)}`;
    const initiatedAt = new Date().toISOString();

    await this.audit("portal.action.initiated", {
      actionId,
      actionType: "restart",
      service,
      platform,
      requestedBy,
      destructiveness: "reversible",
      initiatedAt,
    });

    const gateAction: GateAction = {
      id: actionId,
      destructiveness: "reversible",
      description: `Restart service '${service}' on platform '${platform}' (portal-triggered)`,
      requestedBy: String(requestedBy),
      initiatedAt,
    };

    try {
      await this.gate(gateAction);
    } catch (err) {
      await this.audit("portal.action.gate-denied", {
        actionId,
        actionType: "restart",
        service,
        platform,
        reason: (err as Error).message,
        occurredAt: new Date().toISOString(),
      });
      return {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: `gate denied: ${(err as Error).message}`,
        } satisfies GatedActionResult),
      };
    }

    const apiResult = await this.platformApi("restart", { service, platform });

    await this.audit("portal.action.completed", {
      actionId,
      actionType: "restart",
      service,
      platform,
      ok: apiResult.ok,
      occurredAt: new Date().toISOString(),
    });

    if (!apiResult.ok) {
      return {
        status: 422,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: apiResult.reason ?? "platform API returned failure",
        } satisfies GatedActionResult),
      };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, actionId } satisfies GatedActionResult),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /portal/actions/scale
  // ---------------------------------------------------------------------------

  /**
   * Scale a service via the platform API. Gate approval required.
   */
  private async handleScale(
    body: Record<string, unknown> | null,
  ): Promise<PortalContribResponse> {
    if (body === null) {
      return this.jsonError(400, "request body is required");
    }

    const service = body["service"];
    const replicas = body["replicas"];
    const platform = body["platform"];
    const requestedBy = body["requestedBy"];

    if (typeof service !== "string" || service === "") {
      return this.jsonError(
        400,
        "service is required and must be a non-empty string",
      );
    }
    if (typeof replicas !== "number") {
      return this.jsonError(400, "replicas is required and must be a number");
    }
    if (typeof platform !== "string" || platform === "") {
      return this.jsonError(
        400,
        "platform is required and must be a non-empty string",
      );
    }
    if (typeof requestedBy !== "string" || requestedBy === "") {
      return this.jsonError(
        400,
        "requestedBy is required and must be a non-empty string",
      );
    }

    if (this.platformApi === undefined) {
      return this.jsonError(501, "platformApi not configured");
    }

    const actionId = `act-scale-portal-${Date.now().toString(36)}`;
    const initiatedAt = new Date().toISOString();

    await this.audit("portal.action.initiated", {
      actionId,
      actionType: "scale",
      service,
      replicas,
      platform,
      requestedBy,
      destructiveness: "reversible",
      initiatedAt,
    });

    const gateAction: GateAction = {
      id: actionId,
      destructiveness: "reversible",
      description: `Scale service '${service}' to ${replicas} replicas on platform '${platform}' (portal-triggered)`,
      requestedBy: String(requestedBy),
      initiatedAt,
    };

    try {
      await this.gate(gateAction);
    } catch (err) {
      await this.audit("portal.action.gate-denied", {
        actionId,
        actionType: "scale",
        service,
        replicas,
        reason: (err as Error).message,
        occurredAt: new Date().toISOString(),
      });
      return {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: `gate denied: ${(err as Error).message}`,
        } satisfies GatedActionResult),
      };
    }

    const apiResult = await this.platformApi("scale", {
      service,
      replicas,
      platform,
    });

    await this.audit("portal.action.completed", {
      actionId,
      actionType: "scale",
      service,
      replicas,
      platform,
      ok: apiResult.ok,
      occurredAt: new Date().toISOString(),
    });

    if (!apiResult.ok) {
      return {
        status: 422,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          actionId,
          reason: apiResult.reason ?? "platform API returned failure",
        } satisfies GatedActionResult),
      };
    }

    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: true, actionId } satisfies GatedActionResult),
    };
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  private jsonError(status: number, reason: string): PortalContribResponse {
    return {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, reason }),
    };
  }
}
