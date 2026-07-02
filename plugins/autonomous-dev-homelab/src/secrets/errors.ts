/**
 * Error classes for the Vault secret resolver.
 * SPEC: REQ-000055 §2.7, §3.1.
 *
 * Every class implements `HomelabError` for uniform exit-code handling in
 * the CLI dispatcher. Exit codes match TDD §6 / spec §3.1.
 */

export interface HomelabError extends Error {
  readonly code: string;
  readonly exit: number;
  readonly details?: Record<string, unknown>;
}

/** Vault is unreachable (network error, timeout, or 5xx). */
export class VaultUnreachableError extends Error implements HomelabError {
  readonly code = 'VAULT_UNREACHABLE';
  readonly exit = 20;

  constructor(address: string, authMethod: string, cause?: unknown) {
    super(`vault unreachable: ${address} via ${authMethod}`);
    this.name = 'VaultUnreachableError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Vault auth failed (400/403 on AppRole login). */
export class VaultAuthError extends Error implements HomelabError {
  readonly code = 'VAULT_AUTH_FAILED';
  readonly exit = 21;

  constructor(
    authMethod: string,
    roleIdEnv?: string,
    secretIdEnv?: string,
    cause?: unknown,
  ) {
    const envPart =
      roleIdEnv !== undefined && secretIdEnv !== undefined
        ? `; check ${roleIdEnv}/${secretIdEnv}`
        : '';
    super(`vault auth failed: ${authMethod}${envPart}`);
    this.name = 'VaultAuthError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Vault denies read access to a secret path. */
export class VaultPermissionError extends Error implements HomelabError {
  readonly code = 'VAULT_PERMISSION';
  readonly exit = 22;

  constructor(vaultPath: string, cause?: unknown) {
    super(`vault permission denied: cannot read ${vaultPath}`);
    this.name = 'VaultPermissionError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** A KV path exists but the requested field is absent. */
export class SecretMissingError extends Error implements HomelabError {
  readonly code = 'SECRET_MISSING';
  readonly exit = 23;

  constructor(ref: { vault_path: string; vault_field: string }) {
    super(`vault path ${ref.vault_path} missing field ${ref.vault_field}`);
    this.name = 'SecretMissingError';
  }
}

/** Internal safety: attempted to write secret material to audit. */
export class SecretLeakDetectedError extends Error implements HomelabError {
  readonly code = 'SECRET_LEAK_DETECTED';
  readonly exit = 24;

  constructor(field: string) {
    super(`internal safety: attempted to write secret material to audit (field: ${field})`);
    this.name = 'SecretLeakDetectedError';
  }
}

/** Dry-run blocked a mutation. */
export class MutationBarrierError extends Error implements HomelabError {
  readonly code = 'MUTATION_BARRIER_BLOCKED';
  readonly exit = 42;
  readonly attemptedMethod: string;

  constructor(attemptedMethod: string) {
    super(`dry-run blocked mutation: ${attemptedMethod}`);
    this.name = 'MutationBarrierError';
    this.attemptedMethod = attemptedMethod;
  }
}
