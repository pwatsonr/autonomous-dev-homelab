/**
 * `admin-auth` CLI middleware. Implements SPEC-001-3-04
 * §"Admin Auth Middleware".
 *
 * Centralizes the "is this operator an admin?" check at the dispatcher
 * boundary. Every Commander subcommand that is destructive declares
 * `requiresAdmin: true` (see `cli/types.ts`'s `ADMIN_REQUIRED_COMMANDS`).
 * The dispatcher (`cli/index.ts`) wires `enforceAdminIfRequired` as a
 * `preAction` hook on each top-level command group; the hook resolves the
 * full subcommand path (`'consent revoke'`, `'platform exec'`, etc.) and
 * — if the subcommand requires admin — calls `isAdmin(ctx)` and either
 * proceeds or aborts with exit `1` and the literal stderr message
 * `"Authorization required: admin role"`.
 *
 * Deviation from SPEC §Implementation Details:
 *   The spec references an `@autonomous-dev/auth` `hasAdminRole(actor)`
 *   export from PRD-009. PRD-009 is not yet wired into the homelab plugin
 *   (no peer dependency, no shared types module), so this middleware ships
 *   a self-contained `isAdmin` resolver that reads:
 *     1. `HOMELAB_ADMIN_TOKEN` env var (any non-empty value → admin), OR
 *     2. an admin allow-list file at `<dataDir>/.admin-actors`
 *        (one OS username per line; `actor` must match exactly).
 *   When PRD-009's role channel lands, this resolver becomes a thin
 *   adapter — the dispatcher contract (`enforceAdminIfRequired`) is
 *   stable. Tests inject the resolver directly so the env+file behavior
 *   is exercised at unit level.
 *
 * The middleware does NOT emit an audit entry on auth failure; per the
 * SPEC-001-3-04 §Behavior bullets, blocked attempts are recorded by
 * PRD-009's auth audit channel (single source of truth).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ADMIN_REQUIRED_COMMANDS } from '../types.js';
import type { OutputStreams } from '../output.js';
import { DEFAULT_STREAMS } from '../output.js';

/**
 * Authorization context passed to the middleware. The dispatcher builds
 * one per CLI invocation.
 */
export interface AdminAuthContext {
  /** OS username of the operator. Defaults to `process.env.USER`. */
  actor: string;
  /** Absolute path to the homelab data dir. Used to find `.admin-actors`. */
  dataDir: string;
  /** Process env (exposed for tests). */
  env: NodeJS.ProcessEnv;
}

/**
 * Resolves whether `ctx.actor` has the admin role. Default implementation:
 *   - HOMELAB_ADMIN_TOKEN set (non-empty) → admin
 *   - else `<dataDir>/.admin-actors` lists `ctx.actor` on its own line → admin
 *   - else not admin
 */
export type AdminCheckFn = (ctx: AdminAuthContext) => Promise<boolean>;

/**
 * Standard literal message printed to stderr on rejection. Tests assert
 * exact text (per SPEC-001-3-04 §Behavior).
 */
export const ADMIN_REJECTION_MESSAGE = 'Authorization required: admin role';

/**
 * Default {@link AdminCheckFn}. Reads env then optional allow-list file.
 * Reads are best-effort: any I/O error short-circuits to "not admin".
 */
export const defaultAdminCheck: AdminCheckFn = async (ctx) => {
  const token = ctx.env['HOMELAB_ADMIN_TOKEN'];
  if (typeof token === 'string' && token !== '') return true;

  const allowPath = path.join(ctx.dataDir, '.admin-actors');
  let raw: string;
  try {
    raw = await fs.readFile(allowPath, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === ctx.actor) return true;
  }
  return false;
};

export interface EnforceAdminOptions {
  /** Override the admin resolver (tests inject; production uses the default). */
  isAdmin?: AdminCheckFn;
  /** Streams used for the rejection message. */
  streams?: OutputStreams;
  /**
   * Process exit hook. Tests pass a fake to capture the code; production
   * passes `process.exit`. Awaited so callers can flush before exit; in
   * production this never returns.
   */
  exit: (code: number) => void;
}

/**
 * Enforce the admin role for the given dotted command name (e.g.
 * `'consent revoke'`). When the command is in {@link ADMIN_REQUIRED_COMMANDS}
 * and the resolver reports non-admin, prints
 * {@link ADMIN_REJECTION_MESSAGE} to stderr and calls `opts.exit(1)`. The
 * caller's handler MUST NOT proceed past this call; tests verify this via
 * a spy on the handler.
 *
 * Returns `true` when the call may proceed, `false` when the middleware
 * has rejected. The dispatcher uses the boolean to skip the handler when
 * `exit()` is mocked (in tests) and would otherwise return.
 */
export async function enforceAdminIfRequired(
  commandName: string,
  ctx: AdminAuthContext,
  opts: EnforceAdminOptions,
): Promise<boolean> {
  if (!ADMIN_REQUIRED_COMMANDS.has(commandName)) return true;
  const checker = opts.isAdmin ?? defaultAdminCheck;
  const allowed = await checker(ctx);
  if (allowed) return true;
  const streams = opts.streams ?? DEFAULT_STREAMS;
  streams.stderr(`${ADMIN_REJECTION_MESSAGE}\n`);
  opts.exit(1);
  return false;
}

/**
 * Build an {@link AdminAuthContext} from process state. Used by the
 * dispatcher; tests construct one directly.
 */
export function buildAdminAuthContext(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): AdminAuthContext {
  const actor = env['HOMELAB_ACTOR'] ?? env['USER'] ?? env['LOGNAME'] ?? 'unknown';
  return { actor, dataDir, env };
}
