/**
 * `homelab autofix` command group.
 * SPEC: REQ-000055 §2.14, TASK-010, GitHub issue #13.
 *
 * Subcommands:
 *   autofix propose <observation-id>  — generates and persists a Proposal
 *   autofix dry-run <proposal-id>     — simulates the gate outcome (non-mutating)
 *   autofix apply <proposal-id>       — executes the remediation through the safety gate
 *   autofix abort-pending <action-id> — cancels a delayed action
 *
 * Safety:
 * - `dry-run` MUST NOT make live mutations (enforced by MutationBarrier).
 * - `apply` executes AFTER gate approval using an UNWRAPPED connection.
 * - All proposal IDs are prefixed `prop-` to avoid collision with `act-` action IDs.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Command } from 'commander';
import type { AuditWriter } from '../../audit/writer.js';
import type { OutputStreams } from '../output.js';
import { printJson, printError, DEFAULT_STREAMS } from '../output.js';
import { cancelDelayedAction } from '../../safety/delay.js';
import { ObservationStore } from '../../observation/persistence.js';
import type { Observation } from '../../observation/types.js';
import { gateApproval } from '../../safety/gate.js';
import { ApprovalDeniedError } from '../../safety/errors.js';
import type { Action, GateContext, OperatorConfig, SafetyAuditEvent } from '../../safety/types.js';
import type { Destructiveness } from '../../safety/destructiveness.js';
import type { Connection } from '../../connection/base.js';
import { __setPromptLine } from '../../safety/io-stdin.js';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;

/**
 * Gate outcome descriptions for dry-run (mirrors gate.ts routing logic without
 * actually invoking `typedConfirmModal` or `scheduleDelayedAction`).
 */
export type GateOutcome =
  | 'WOULD_REQUIRE_TYPED_CONFIRM'
  | 'WOULD_DELAY_24H'
  | 'WOULD_EXECUTE_L2_PLUS';

/**
 * On-disk proposal record.
 * `destructiveness` is the classification used by the real gate.
 * `params` carries remediation-specific fields (e.g. `service`, `command`).
 * `unsupported` is true when no safe auto-remediation exists for the pattern.
 */
export interface Proposal {
  id: string; // "prop-YYYY-MM-DD-<8-hex>"
  created_at: string; // ISO-8601 UTC
  observation_id: string;
  target_host: string;
  action_class: string;
  params: Record<string, unknown>;
  destructiveness: Destructiveness;
  ladder_level: 'L0' | 'L1' | 'L2' | 'L3';
  requires_typed_confirm: boolean;
  delay_hours: number;
  notes: string;
  /** True when no safe automatic remediation exists for the observed pattern. */
  unsupported?: boolean;
}

/**
 * Default OperatorConfig used by the apply gate when no config is injected.
 * Every level is set to the FLOOR (most restrictive valid value) so no
 * auto-approval below L0 is possible.
 */
const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  auto_approval: {
    'read-only': 'L3',
    reversible: 'L0',
    'persistent-modifying': 'L0',
    'data-affecting': 'L0',
    architectural: 'L0',
  },
  typed_confirm_ttl_seconds: 60,
};

export interface AutofixDeps {
  audit: AuditWriter;
  streams: OutputStreams;
  /** Override data dir (for tests). Defaults to ~/.autonomous-dev-homelab */
  dataDir?: string;
  /** Cancel function (for tests). Defaults to cancelDelayedAction. */
  cancel?: (id: string) => Promise<void>;
  /**
   * Connection factory for `apply` (for tests).
   * When provided, used instead of assembling a live runtime.
   * Receives the target_host from the proposal.
   */
  getConnection?: (hostname: string) => Promise<Connection>;
  /**
   * Operator config for the gate (for tests).
   * Defaults to DEFAULT_OPERATOR_CONFIG when undefined.
   */
  operatorConfig?: OperatorConfig;
  /**
   * Admin check for the gate context (for tests).
   * Defaults to `() => false` (non-admin) when undefined.
   */
  isAdmin?: () => boolean;
  /**
   * Test-only: inject a confirmation answer into the typed-CONFIRM modal
   * so tests can simulate operator input without stdin. When set, the
   * mock prompter returns this value. Production MUST leave this undefined.
   */
  _testConfirmAnswer?: string;
}

function generateProposalId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hex = crypto.randomBytes(4).toString('hex');
  return `prop-${yyyy}-${mm}-${dd}-${hex}`;
}

function resolveDataDir(deps: AutofixDeps): string {
  return deps.dataDir ?? path.join(os.homedir(), '.autonomous-dev-homelab');
}

/**
 * Classify an observation into a concrete destructiveness level for the
 * remediation Action. Returns `null` when no safe auto-remediation exists.
 *
 * Mapping rules (TDD-002 §8):
 * - crash_loop on docker-swarm: `docker service update --force` is reversible
 *   (the service is not deleted; restarting a service is non-permanent).
 *   Classification: `reversible` — typed-CONFIRM required, no 24h delay.
 * - All other patterns: unsupported (no bogus mutation).
 */
function classifyRemediation(obs: Observation): {
  destructiveness: Destructiveness;
  actionClass: string;
  command: string;
  service: string;
} | null {
  // A crash-looping Docker Swarm service is reported with resource
  // "service/<name>" (the platform field holds the host id, not the platform
  // type, so we key off the resource prefix). Remediation is a forced service
  // restart, which is reversible (no data/config change).
  if (obs.pattern === 'crash_loop' && obs.resource.startsWith('service/')) {
    const serviceName = obs.resource.slice('service/'.length);
    const command = `docker service update --force ${serviceName}`;
    return {
      destructiveness: 'reversible',
      actionClass: 'container.restart',
      command,
      service: serviceName,
    };
  }
  return null;
}

/**
 * Derive the GateOutcome from a proposal's destructiveness classification.
 * This mirrors gate.ts routing logic without actually invoking the gate.
 */
function deriveGateOutcome(destructiveness: Destructiveness): GateOutcome {
  switch (destructiveness) {
    case 'read-only':
      return 'WOULD_EXECUTE_L2_PLUS';
    case 'reversible':
    case 'persistent-modifying':
      return 'WOULD_REQUIRE_TYPED_CONFIRM';
    case 'data-affecting':
    case 'architectural':
      return 'WOULD_DELAY_24H';
    default: {
      const _exhaustive: never = destructiveness;
      throw new Error(`Unknown destructiveness: ${_exhaustive as string}`);
    }
  }
}

/**
 * Derive ladder level from destructiveness for proposal metadata.
 * L0 = strictest approval requirement.
 */
function destructivenessToLadder(d: Destructiveness): 'L0' | 'L1' | 'L2' | 'L3' {
  switch (d) {
    case 'read-only':
      return 'L3';
    case 'reversible':
      return 'L1';
    case 'persistent-modifying':
    case 'data-affecting':
    case 'architectural':
      return 'L0';
    default: {
      const _exhaustive: never = d;
      throw new Error(`Unknown destructiveness: ${_exhaustive as string}`);
    }
  }
}

/**
 * Propose an autofix for an observation.
 * Loads the observation from disk, maps (pattern, platform, resource) to
 * a concrete remediation. Writes a Proposal JSON to
 * `.autonomous-dev/proposals/<id>.json` with mode 0o600.
 * Uses atomic write (tmp → rename) for safety.
 *
 * For patterns with no safe automatic remediation, writes a no-op proposal
 * with `unsupported: true` instead of generating a bogus mutation.
 */
export async function runAutofixPropose(
  deps: AutofixDeps,
  observationId: string,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const dataDir = resolveDataDir(deps);

  // Load the observation to inform the proposal.
  const store = new ObservationStore(dataDir);
  let obs: Observation;
  try {
    obs = await store.load(observationId);
  } catch (err) {
    printError(`observation '${observationId}' not found: ${(err as Error).message}`, streams);
    return EXIT_FAIL;
  }

  const classification = classifyRemediation(obs);

  let proposal: Proposal;
  if (classification === null) {
    // Unsupported pattern: emit a no-op proposal rather than a bogus mutation.
    proposal = {
      id: generateProposalId(),
      created_at: new Date().toISOString(),
      observation_id: observationId,
      target_host: obs.platform,
      action_class: 'noop',
      params: { pattern: obs.pattern },
      destructiveness: 'read-only',
      ladder_level: 'L3',
      requires_typed_confirm: false,
      delay_hours: 0,
      notes: `No safe auto-remediation for pattern '${obs.pattern}' on platform '${obs.platform}'.`,
      unsupported: true,
    };
  } else {
    proposal = {
      id: generateProposalId(),
      created_at: new Date().toISOString(),
      observation_id: observationId,
      target_host: obs.platform,
      action_class: classification.actionClass,
      params: {
        service: classification.service,
        command: classification.command,
      },
      destructiveness: classification.destructiveness,
      ladder_level: destructivenessToLadder(classification.destructiveness),
      requires_typed_confirm: true,
      delay_hours: 0,
      notes: `Auto-remediation for '${obs.pattern}' on '${obs.resource}'.`,
    };
  }

  const proposalsDir = path.join(dataDir, '.autonomous-dev', 'proposals');
  await fs.mkdir(proposalsDir, { recursive: true });

  const proposalPath = path.join(proposalsDir, `${proposal.id}.json`);
  const tmpPath = proposalPath + '.tmp';

  const json = JSON.stringify(proposal, null, 2);
  await fs.writeFile(tmpPath, json, { mode: 0o600, encoding: 'utf8' });
  await fs.rename(tmpPath, proposalPath);

  await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
    type: 'autofix.propose',
    proposal_id: proposal.id,
    observation_id: observationId,
    target_host: proposal.target_host,
    action_class: proposal.action_class,
    destructiveness: proposal.destructiveness,
    ladder_level: proposal.ladder_level,
    occurred_at: new Date().toISOString(),
  });

  printJson({ proposal_id: proposal.id, status: 'proposed', unsupported: proposal.unsupported === true }, streams);
  return EXIT_OK;
}

/**
 * Dry-run an autofix proposal.
 * Non-mutating: derives the gate outcome from the proposal's actual
 * destructiveness classification (mirrors gate.ts routing). Does NOT invoke
 * gateApproval, typedConfirmModal, or any connection exec.
 * Prints the GateOutcome and writes an autofix.dry-run audit event.
 */
export async function runAutofixDryRun(
  deps: AutofixDeps,
  proposalId: string,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;

  // Read proposal from disk
  const dataDir = resolveDataDir(deps);
  const proposalPath = path.join(dataDir, '.autonomous-dev', 'proposals', `${proposalId}.json`);

  let proposal: Proposal;
  try {
    const raw = await fs.readFile(proposalPath, 'utf8');
    proposal = JSON.parse(raw) as Proposal;
  } catch (err) {
    printError(`proposal '${proposalId}' not found: ${(err as Error).message}`, streams);
    return EXIT_FAIL;
  }

  // Derive gate outcome from the real destructiveness classification.
  const gateOutcome: GateOutcome = deriveGateOutcome(proposal.destructiveness);

  await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
    type: 'autofix.dry-run',
    proposal_id: proposalId,
    destructiveness: proposal.destructiveness,
    gate_outcome: gateOutcome,
    occurred_at: new Date().toISOString(),
  });

  printJson({ proposal_id: proposalId, gate_outcome: gateOutcome, destructiveness: proposal.destructiveness }, streams);
  streams.stdout(`Gate outcome: ${gateOutcome}\n`);
  return EXIT_OK;
}

/**
 * Apply an autofix proposal by executing the remediation through the real
 * safety gate.
 *
 * Flow:
 *   1. Load the proposal from disk.
 *   2. Reject unsupported (no-op) proposals immediately.
 *   3. Build an Action from the proposal.
 *   4. Build a GateContext (audit sink + isAdmin + operatorConfig).
 *   5. Call gateApproval(action, ctx) — this may invoke typedConfirmModal.
 *   6. On approval, obtain a live connection and exec the remediation command.
 *   7. Write autofix.apply audit event with exit code + stdout.
 *   8. On gate denial (ApprovalDeniedError), return EXIT_FAIL. The gate
 *      already emitted the gate.denied audit event.
 *   9. If the gate schedules a 24h delay (architectural), report scheduling.
 *
 * Safety invariants:
 * - Only a raw (unwrapped) connection is used for exec; dry-run never calls
 *   this path.
 * - typed-CONFIRM is never bypassed except via `_testConfirmAnswer` (test
 *   seam only).
 * - Gate denial always returns EXIT_FAIL.
 */
export async function runAutofixApply(
  deps: AutofixDeps,
  proposalId: string,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const dataDir = resolveDataDir(deps);

  // Step 1: Load the proposal.
  const proposalPath = path.join(dataDir, '.autonomous-dev', 'proposals', `${proposalId}.json`);
  let proposal: Proposal;
  try {
    const raw = await fs.readFile(proposalPath, 'utf8');
    proposal = JSON.parse(raw) as Proposal;
  } catch (err) {
    printError(`proposal '${proposalId}' not found: ${(err as Error).message}`, streams);
    return EXIT_FAIL;
  }

  // Step 2: Reject unsupported proposals.
  if (proposal.unsupported === true) {
    printError(
      `proposal '${proposalId}' has no supported remediation (pattern: ${String(proposal.params['pattern'] ?? 'unknown')}). Apply is not available.`,
      streams,
    );
    return EXIT_FAIL;
  }

  // Step 3: Build the Action.
  const actionId = `act-autofix-${crypto.randomBytes(6).toString('hex')}`;
  const action: Action = {
    id: actionId,
    destructiveness: proposal.destructiveness,
    target: {
      platform: proposal.target_host,
      resource: String(proposal.params['service'] ?? proposal.target_host),
    },
    description: `Autofix: ${proposal.action_class} on ${proposal.target_host}/${String(proposal.params['service'] ?? '')} (proposal ${proposalId})`,
    requestedBy: 'autofix-cli',
    initiatedAt: new Date().toISOString(),
  };

  // Step 4: Build the GateContext.
  const auditFn = async (event: SafetyAuditEvent): Promise<void> => {
    await deps.audit.append(
      'observation_created' as Parameters<AuditWriter['append']>[0],
      {
        type: event.type,
        action_id: event.action_id,
        reason: event.reason,
        occurred_at: event.occurred_at,
      },
    );
  };

  const operatorConfig: OperatorConfig = deps.operatorConfig ?? DEFAULT_OPERATOR_CONFIG;
  const isAdmin: () => boolean = deps.isAdmin ?? (() => false);

  const ctx: GateContext = {
    config: operatorConfig,
    isAdmin,
    audit: auditFn,
  };

  // Step 5: Inject test confirmation if provided (test-only seam).
  let injectedPromptLine: undefined | (() => void);
  if (deps._testConfirmAnswer !== undefined) {
    const answer = deps._testConfirmAnswer;
    __setPromptLine(async () => answer);
    injectedPromptLine = (): void => __setPromptLine(undefined);
  }

  try {
    // Step 5 (cont): Call the real gate.
    await gateApproval(action, ctx);

    // Step 6: On approval, obtain a live connection and exec.
    const command = String(proposal.params['command'] ?? '');
    if (command === '') {
      printError(`proposal '${proposalId}' has no command to execute.`, streams);
      return EXIT_FAIL;
    }

    if (deps.getConnection === undefined) {
      // No connection factory injected. In production this path would
      // call assembleRuntime; for now we surface a clear error so callers
      // know to provide a factory.
      printError(
        `No connection factory available. Provide getConnection in deps or wire assembleRuntime.`,
        streams,
      );
      return EXIT_FAIL;
    }

    const conn = await deps.getConnection(proposal.target_host);
    const execResult = await conn.exec(command);

    // Step 7: Write autofix.apply audit event.
    await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
      type: 'autofix.apply',
      proposal_id: proposalId,
      action_id: actionId,
      target_host: proposal.target_host,
      command,
      exit_code: execResult.exitCode,
      stdout_tail: execResult.stdout.slice(-500),
      occurred_at: new Date().toISOString(),
    });

    if (execResult.exitCode !== 0) {
      printError(
        `Remediation command exited with code ${execResult.exitCode}: ${execResult.stderr}`,
        streams,
      );
      printJson({
        proposal_id: proposalId,
        action_id: actionId,
        status: 'failed',
        exit_code: execResult.exitCode,
      }, streams);
      return EXIT_FAIL;
    }

    printJson({
      proposal_id: proposalId,
      action_id: actionId,
      status: 'applied',
      exit_code: execResult.exitCode,
    }, streams);
    streams.stdout(`Autofix applied successfully. action_id=${actionId}\n`);
    return EXIT_OK;

  } catch (err) {
    if (err instanceof ApprovalDeniedError) {
      // Gate already emitted gate.denied audit event.
      printError(`Gate denied: ${err.message}`, streams);
      return EXIT_FAIL;
    }
    // Other errors (e.g. connection failure, backup required).
    const e = err as Error;
    await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
      type: 'autofix.apply',
      proposal_id: proposalId,
      action_id: actionId,
      status: 'error',
      error: e.message,
      occurred_at: new Date().toISOString(),
    });
    printError(`Autofix apply failed: ${e.message}`, streams);
    return EXIT_FAIL;
  } finally {
    // Clean up test prompt injection if set.
    if (injectedPromptLine !== undefined) {
      injectedPromptLine();
    }
  }
}

/**
 * Abort a pending delayed action.
 * Delegates to cancelDelayedAction and writes an action.cancelled audit event.
 */
export async function runAutofixAbortPending(
  deps: AutofixDeps,
  actionId: string,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const cancelFn = deps.cancel ?? cancelDelayedAction;

  await cancelFn(actionId);

  await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
    type: 'action.cancelled',
    action_id: actionId,
    reason: 'operator abort via CLI',
    occurred_at: new Date().toISOString(),
  });

  streams.stdout(`Action ${actionId} aborted.\n`);
  return EXIT_OK;
}

export interface AutofixCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Build the `autofix` Commander subcommand tree. */
export function buildAutofixCommand(deps: AutofixDeps): AutofixCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('autofix').description('Manage autofix proposals and actions.');

  cmd
    .command('propose')
    .description('Propose an autofix for an observation.')
    .argument('<observation-id>', 'Observation ID to fix')
    .option('--json', 'Emit JSON output')
    .action(async (observationId: string) => {
      lastExit = await runAutofixPropose({ ...deps, streams }, observationId);
    });

  cmd
    .command('dry-run')
    .description('Simulate the gate outcome for a proposal (non-mutating).')
    .argument('<proposal-id>', 'Proposal ID to dry-run')
    .option('--json', 'Emit JSON output')
    .action(async (proposalId: string) => {
      lastExit = await runAutofixDryRun({ ...deps, streams }, proposalId);
    });

  cmd
    .command('apply')
    .description('Execute a remediation through the real safety gate.')
    .argument('<proposal-id>', 'Proposal ID to apply')
    .option('--json', 'Emit JSON output')
    .action(async (proposalId: string) => {
      lastExit = await runAutofixApply({ ...deps, streams }, proposalId);
    });

  cmd
    .command('abort-pending')
    .description('Abort a pending delayed action.')
    .argument('<action-id>', 'Action ID to abort')
    .action(async (actionId: string) => {
      lastExit = await runAutofixAbortPending({ ...deps, streams }, actionId);
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
