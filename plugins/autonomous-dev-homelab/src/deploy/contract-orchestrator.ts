/**
 * Contract orchestrator (#666) — routes a `DeployContractRequest` to the
 * correct dispatch path after evaluating the stateful backup precondition.
 *
 * Dispatch rules:
 *   - `target.location === 'homelab'` → `dispatchHomelab` (delegate to plugin gate).
 *   - `target.location === 'cloud'`   → `dispatchCloud` (GCP/AWS/Azure/K8s; unchanged).
 *
 * The orchestrator evaluates the stateful precondition BEFORE dispatch and
 * BLOCKS the deploy if the precondition is not satisfied. Core owns no
 * backup-engine logic; enforcement is the plugin's responsibility.
 *
 * Governing invariant #674: all branching is on location/capabilities/tags —
 * never on instance ids or hard-coded service names.
 */

import {
  evaluateStatefulPrecondition,
  type DeployContractRequest,
  type BackupClass,
} from "./contract.js";

// ---------------------------------------------------------------------------
// Dispatch context
// ---------------------------------------------------------------------------

/**
 * Context forwarded to the cloud dispatch handler. Carries the resolved
 * `backup_class` so cloud backends can record it without re-resolving.
 */
export interface CloudDispatchContext {
  request: DeployContractRequest;
  backup_class: BackupClass;
}

/**
 * Context forwarded to the homelab dispatch handler. Carries the resolved
 * `backup_class` and any backup reference, enabling the plugin's approval/
 * safety gate to use them without re-parsing the request.
 */
export interface HomelabDispatchContext {
  request: DeployContractRequest;
  backup_class: BackupClass;
  verifiedBackupRef?: string;
  overrideApplied: boolean;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * Injectable dispatch functions for the contract orchestrator.
 * Injected at construction/call time so tests can mock both paths.
 */
export interface ContractOrchestrationDeps {
  /**
   * Dispatches to the cloud backend (GCP/AWS/Azure/K8s). The cloud path is
   * UNCHANGED by issue #666; this function is a pass-through.
   */
  dispatchCloud: (ctx: CloudDispatchContext) => Promise<unknown>;

  /**
   * Delegates to the homelab plugin's approval/safety gate (typed-CONFIRM,
   * 24h delay, mutation barrier). Core does NOT reimplement the gate — it
   * only calls this function and records the result.
   */
  dispatchHomelab: (ctx: HomelabDispatchContext) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Outcome of a `orchestrateContractDeploy` call.
 */
export interface ContractOrchestrationResult {
  status: "dispatched" | "blocked";
  location?: "cloud" | "homelab";
  reason?: string;
  dispatchResult?: unknown;
}

// ---------------------------------------------------------------------------
// orchestrateContractDeploy
// ---------------------------------------------------------------------------

/**
 * Evaluates the stateful precondition and dispatches the deploy to the
 * correct backend.
 *
 * Steps:
 *  1. Evaluate `evaluateStatefulPrecondition(request)`. If blocked, return
 *     `{ status: 'blocked', reason }` without calling any dispatch function.
 *  2. Branch on `request.target.location`:
 *     - `'homelab'` → call `deps.dispatchHomelab` with a `HomelabDispatchContext`.
 *     - `'cloud'`   → call `deps.dispatchCloud` with a `CloudDispatchContext`.
 *  3. Return `{ status: 'dispatched', location, dispatchResult }`.
 *
 * @param request - The validated deploy contract request.
 * @param deps    - Injected dispatch functions.
 * @returns A `ContractOrchestrationResult`.
 */
export async function orchestrateContractDeploy(
  request: DeployContractRequest,
  deps: ContractOrchestrationDeps,
): Promise<ContractOrchestrationResult> {
  // Step 1: evaluate stateful precondition.
  const precondition = evaluateStatefulPrecondition(request);
  if (!precondition.allowed) {
    return {
      status: "blocked",
      reason: precondition.reason,
    };
  }

  const backup_class = request.target.backup_class;

  // Step 2: dispatch to the correct backend.
  if (request.target.location === "homelab") {
    const ctx: HomelabDispatchContext = {
      request,
      backup_class,
      verifiedBackupRef: request.verifiedBackupRef,
      overrideApplied: precondition.overrideApplied === true,
    };
    const dispatchResult = await deps.dispatchHomelab(ctx);
    return { status: "dispatched", location: "homelab", dispatchResult };
  }

  // Cloud path (GCP/AWS/Azure/K8s) — unchanged by #666.
  const ctx: CloudDispatchContext = {
    request,
    backup_class,
  };
  const dispatchResult = await deps.dispatchCloud(ctx);
  return { status: "dispatched", location: "cloud", dispatchResult };
}
