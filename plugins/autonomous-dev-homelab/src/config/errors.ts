/**
 * Config error classes for the homelab configuration loader.
 * SPEC: REQ-000055 §3.1.
 *
 * All classes implement `HomelabError` for uniform exit-code handling
 * in the CLI dispatcher.
 */

export interface HomelabError extends Error {
  readonly code: string;
  readonly exit: number;
  readonly details?: Record<string, unknown>;
}

/** Configuration file is syntactically invalid or violates the Zod schema. */
export class ConfigInvalidError extends Error implements HomelabError {
  readonly code = 'CONFIG_INVALID';
  readonly exit = 11;
  readonly details?: Record<string, unknown>;

  constructor(configPath: string, reason: string, details?: Record<string, unknown>) {
    super(`config error at ${configPath}: ${reason}`);
    this.name = 'ConfigInvalidError';
    if (details !== undefined) this.details = details;
  }
}

/** Configuration file is absent or unreadable. */
export class ConfigNotFoundError extends Error implements HomelabError {
  readonly code = 'CONFIG_NOT_FOUND';
  readonly exit = 12;

  constructor(configPath: string) {
    super(
      `config not found: ${configPath}. Run 'homelab config init' or set --config.`,
    );
    this.name = 'ConfigNotFoundError';
  }
}
