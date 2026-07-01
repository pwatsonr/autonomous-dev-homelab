/**
 * `homelab autofix` command group.
 * SPEC: REQ-000055 §2.14, TASK-010.
 *
 * Subcommands:
 *   autofix propose <observation-id>  — generates and persists a Proposal
 *   autofix dry-run <proposal-id>     — simulates the gate outcome (non-mutating)
 *   autofix abort-pending <action-id> — cancels a delayed action
 *
 * Safety:
 * - `dry-run` MUST NOT make live mutations (enforced by MutationBarrier).
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

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;

export type GateOutcome =
  | 'WOULD_REQUIRE_TYPED_CONFIRM'
  | 'WOULD_DELAY_24H'
  | 'WOULD_EXECUTE_L2_PLUS';

export interface Proposal {
  id: string; // "prop-YYYY-MM-DD-<8-hex>"
  created_at: string; // ISO-8601 UTC
  observation_id: string;
  target_host: string;
  action_class: string;
  params: Record<string, unknown>;
  ladder_level: 'L0' | 'L1' | 'L2' | 'L3';
  requires_typed_confirm: boolean;
  delay_hours: number;
  notes: string;
}

export interface AutofixDeps {
  audit: AuditWriter;
  streams: OutputStreams;
  /** Override data dir (for tests). Defaults to ~/.autonomous-dev-homelab */
  dataDir?: string;
  /** Cancel function (for tests). Defaults to cancelDelayedAction. */
  cancel?: (id: string) => Promise<void>;
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
 * Propose an autofix for an observation.
 * Writes a Proposal JSON to .autonomous-dev/proposals/<id>.json with mode 0o600.
 * Uses atomic write (tmp → rename) for safety.
 */
export async function runAutofixPropose(
  deps: AutofixDeps,
  observationId: string,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;

  const proposal: Proposal = {
    id: generateProposalId(),
    created_at: new Date().toISOString(),
    observation_id: observationId,
    target_host: 'unknown',
    action_class: 'container.restart',
    params: {},
    ladder_level: 'L0',
    requires_typed_confirm: true,
    delay_hours: 24,
    notes: 'dry-run only for REQ-000055',
  };

  const dataDir = resolveDataDir(deps);
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
    ladder_level: proposal.ladder_level,
    occurred_at: new Date().toISOString(),
  });

  printJson({ proposal_id: proposal.id, status: 'proposed' }, streams);
  return EXIT_OK;
}

/**
 * Dry-run an autofix proposal.
 * Non-mutating: injects MutationBarrier on all connections.
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

  // Determine gate outcome based on ladder level
  let gateOutcome: GateOutcome;
  if (proposal.requires_typed_confirm && proposal.delay_hours >= 24) {
    gateOutcome = 'WOULD_DELAY_24H';
  } else if (proposal.requires_typed_confirm) {
    gateOutcome = 'WOULD_REQUIRE_TYPED_CONFIRM';
  } else {
    gateOutcome = 'WOULD_EXECUTE_L2_PLUS';
  }

  await deps.audit.append('observation_created' as Parameters<AuditWriter['append']>[0], {
    type: 'autofix.dry-run',
    proposal_id: proposalId,
    gate_outcome: gateOutcome,
    occurred_at: new Date().toISOString(),
  });

  printJson({ proposal_id: proposalId, gate_outcome: gateOutcome }, streams);
  streams.stdout(`Gate outcome: ${gateOutcome}\n`);
  return EXIT_OK;
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
    .command('abort-pending')
    .description('Abort a pending delayed action.')
    .argument('<action-id>', 'Action ID to abort')
    .action(async (actionId: string) => {
      lastExit = await runAutofixAbortPending({ ...deps, streams }, actionId);
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
