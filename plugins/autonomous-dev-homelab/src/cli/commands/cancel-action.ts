/**
 * `homelab cancel-action <id>` per SPEC-002-2-04.
 *
 * Delegates to `cancelDelayedAction` (idempotent — cancelling unknown,
 * already-cancelled, or already-fired ids is a no-op). Optionally writes
 * an audit entry through an injected `audit` callback so tests can spy.
 */

import { Command } from 'commander';
import { cancelDelayedAction } from '../../safety/delay.js';
import { EXIT_OK } from '../exit-codes.js';
import { printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface CancelAuditEvent {
  type: 'action.cancelled';
  action_id: string;
  occurred_at: string;
}

export type CancelAuditFn = (event: CancelAuditEvent) => Promise<void>;

export interface CancelActionDeps {
  /** Optional audit sink. Defaults to no-op. Production wires `AuditWriter`. */
  audit?: CancelAuditFn;
  /** Override `cancelDelayedAction` for tests. */
  cancel?: (id: string) => Promise<void>;
  streams?: OutputStreams;
}

export interface CancelActionHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Pure-function entry point. */
export async function runCancelAction(
  id: string,
  opts: { json?: boolean },
  deps: CancelActionDeps = {},
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const cancel = deps.cancel ?? cancelDelayedAction;
  await cancel(id);
  if (deps.audit !== undefined) {
    await deps.audit({
      type: 'action.cancelled',
      action_id: id,
      occurred_at: new Date().toISOString(),
    });
  }
  if (opts.json === true) {
    printJson({ action_id: id, status: 'cancelled' }, streams);
  } else {
    streams.stdout(`Action ${id} cancelled.\n`);
  }
  return EXIT_OK;
}

/** Build the `cancel-action` Commander subcommand. */
export function buildCancelActionCommand(deps: CancelActionDeps = {}): CancelActionHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('cancel-action')
    .description('Cancel a pending architectural-action delay.')
    .argument('<id>', 'action identifier')
    .option('--json', 'emit JSON instead of human-readable text')
    .action(async (id: string, cmdOpts: { json?: boolean }) => {
      lastExit = await runCancelAction(
        id,
        { json: cmdOpts.json === true },
        { ...deps, streams },
      );
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
