/**
 * `homelab safety check <action-id>` per SPEC-002-2-04.
 *
 * Previews the destructiveness/floor/required-approvals for an action.
 * Read-only; takes no destructive path.
 *
 * `loadAction` is injected so this command remains testable without the
 * (not-yet-merged) PLAN-002-1 action store. Production wiring resolves
 * the live store from the data dir.
 */

import { Command } from 'commander';
import { FLOOR, type Destructiveness } from '../../safety/destructiveness.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

/** Minimal Action shape needed by `safety check`. */
export interface SafetyCheckAction {
  id: string;
  destructiveness: Destructiveness;
}

export type LoadActionFn = (actionId: string) => Promise<SafetyCheckAction | null>;

export interface SafetyCommandDeps {
  loadAction: LoadActionFn;
  streams?: OutputStreams;
}

export interface SafetyCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/**
 * Returns the human-readable required-approvals list for a destructiveness
 * level. `read-only` and `reversible` and `persistent-modifying` return [].
 */
function requiredApprovals(level: Destructiveness): string[] {
  switch (level) {
    case 'data-affecting':
      return ['typed-CONFIRM', 'backup verification'];
    case 'architectural':
      return ['dry-run', '24h delay', 'typed-CONFIRM', 'backup verification'];
    case 'read-only':
    case 'reversible':
    case 'persistent-modifying':
      return [];
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

export interface SafetyCheckResult {
  action_id: string;
  destructiveness: Destructiveness;
  floor: string;
  required_approvals: string[];
}

/** Pure-function entry point used by tests; returns the view object + exit code. */
export async function runSafetyCheck(
  actionId: string,
  opts: { json?: boolean },
  deps: SafetyCommandDeps,
): Promise<{ exitCode: number; result?: SafetyCheckResult }> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const action = await deps.loadAction(actionId);
  if (action === null) {
    printError(`action not found: ${actionId}`, streams);
    return { exitCode: EXIT_USAGE };
  }
  const floor = FLOOR[action.destructiveness];
  const requires = requiredApprovals(action.destructiveness);
  const result: SafetyCheckResult = {
    action_id: actionId,
    destructiveness: action.destructiveness,
    floor,
    required_approvals: requires,
  };
  if (opts.json === true) {
    printJson(result, streams);
  } else {
    streams.stdout(
      `Action ${actionId}\n` +
        `  destructiveness: ${result.destructiveness}\n` +
        `  floor: ${result.floor}\n` +
        `  required: ${requires.length === 0 ? 'none' : requires.join(', ')}\n`,
    );
  }
  return { exitCode: EXIT_OK, result };
}

/** Build the `safety` Commander subcommand. */
export function buildSafetyCommand(deps: SafetyCommandDeps): SafetyCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('safety').description('Inspect safety attributes of pending actions.');

  cmd
    .command('check')
    .description('Print destructiveness, floor, and required-approvals for an action.')
    .argument('<action-id>', 'pending action identifier')
    .option('--json', 'emit JSON instead of human-readable text')
    .action(async (actionId: string, cmdOpts: { json?: boolean }) => {
      const r = await runSafetyCheck(
        actionId,
        { json: cmdOpts.json === true },
        { loadAction: deps.loadAction, streams },
      );
      lastExit = r.exitCode;
    });

  return { command: cmd, lastExitCode: () => lastExit };
}
