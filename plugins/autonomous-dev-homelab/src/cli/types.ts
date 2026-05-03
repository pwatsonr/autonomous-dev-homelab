/**
 * Shared CLI types for the homelab plugin. Implements SPEC-001-3-03
 * §"`requiresAdmin` Flag" and SPEC-001-3-04 §"Admin Auth Middleware".
 *
 * `CommandDefinition` is the metadata shape used by the admin-auth
 * middleware (SPEC-001-3-04) to decide whether a command is destructive
 * and therefore requires the admin role. SPEC-001-3-03 declares the flag
 * on each destructive subcommand; SPEC-001-3-04 enforces it.
 *
 * Note: this is metadata only. Commander itself dispatches subcommands;
 * the middleware reads `requiresAdmin` from the registry that
 * SPEC-001-3-04's dispatcher consults during dispatch.
 */

/** Describes a CLI command for the admin-auth middleware. */
export interface CommandDefinition {
  /** Dotted path: `'consent revoke'`, `'ca init'`, `'platform exec'`. */
  name: string;
  /** Human-readable summary mirrored to `--help`. */
  description: string;
  /**
   * When true, the admin-auth middleware refuses to run the handler if
   * the current operator lacks the admin role. Defaults to false.
   */
  requiresAdmin?: boolean;
}

/**
 * Registry of every command that requires the admin role. The
 * SPEC-001-3-04 middleware consults this registry to decide whether to
 * call into PRD-009's `hasAdminRole` check.
 *
 * SPEC-001-3-03 declares: `consent revoke`, `ca init`, `ca rotate`.
 * SPEC-001-3-04 adds: `platform exec`, `inventory remove`.
 */
export const ADMIN_REQUIRED_COMMANDS: ReadonlySet<string> = new Set<string>([
  'consent revoke',
  'ca init',
  'ca rotate',
  'platform exec',
  'inventory remove',
]);
