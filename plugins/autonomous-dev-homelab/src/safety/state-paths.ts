/**
 * Path resolution for safety state files. SPEC-002-2-02.
 *
 * Resolution chain for the data dir:
 *   1. `HOMELAB_DATA_DIR`
 *   2. `CLAUDE_PLUGIN_DATA`
 *   3. `<cwd>/.homelab-data`
 *
 * Action ids are validated against a strict regex (alphanumerics +
 * dash/underscore) to prevent path-traversal via crafted ids.
 */

import * as path from 'node:path';

/** Resolves the homelab data dir (env override → default). */
export function dataDir(): string {
  const fromEnv = process.env['HOMELAB_DATA_DIR'] ?? process.env['CLAUDE_PLUGIN_DATA'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.resolve(process.cwd(), '.homelab-data');
}

/** Directory holding pending-action state files. */
export function pendingActionsDir(): string {
  return path.join(dataDir(), 'pending-actions');
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolves the absolute path for a pending-action JSON file. Throws
 * `Error: Invalid action_id` if `actionId` contains anything outside
 * `[A-Za-z0-9_-]`.
 */
export function pendingActionPath(actionId: string): string {
  if (!SAFE_ID.test(actionId)) {
    throw new Error(`Invalid action_id: ${actionId}`);
  }
  return path.join(pendingActionsDir(), `${actionId}.json`);
}
