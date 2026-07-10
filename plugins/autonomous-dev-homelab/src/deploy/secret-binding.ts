/**
 * Deploy-time secret binding via CredentialProxy (#667).
 *
 * Provides `resolveSecretBindings` — resolves secret references
 * JUST-IN-TIME through a `CredentialProxy` into scoped short-lived
 * credentials for ANY target (cloud or homelab).
 *
 * Safety invariants:
 *   - Only `refHash` (a one-way SHA-256 of the `credentialRef`) is persisted
 *     to `DeploymentRecord`. Never secret material, never log values.
 *   - Each binding is permission-checked against the resolved target id BEFORE
 *     the CredentialProxy is called.
 *   - Both `injectAs: 'env'` and `injectAs: 'file'` are supported.
 *
 * The CredentialProxy interface consumed here is the LOCAL shim defined in
 * `credential-proxy-types.ts`, so the homelab plugin's shim satisfies the
 * same resolution path as the core proxy.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// CredentialProxy (minimal interface — structural, not imported from types)
// ---------------------------------------------------------------------------

/**
 * Minimal CredentialProxy interface consumed by secret binding.
 * Structurally compatible with `CredentialProxy` in `credential-proxy-types.ts`.
 */
interface CredentialProxy {
  acquire(
    kind: string,
    op: string,
    scope: { resource: string },
  ): Promise<{
    kubeconfig: string;
    expiresAt: string;
    tokenLifetimeSeconds: number;
  }>;
}

// ---------------------------------------------------------------------------
// SecretBinding — the declaration
// ---------------------------------------------------------------------------

/**
 * A declaration that a named secret should be resolved at deploy time and
 * injected into the deployment environment.
 */
export interface SecretBinding {
  /**
   * Reference to the credential in the secret store.
   * Format is provider-defined (e.g. `'vault:secret/myapp/db-password'`).
   * This value is NEVER persisted; only its hash is recorded.
   */
  credentialRef: string;

  /**
   * How the resolved secret is injected:
   *   - `'env'`  — inject as an environment variable named `name`.
   *   - `'file'` — write content to the file path specified by `name`.
   */
  injectAs: "env" | "file";

  /**
   * Name of the env var (when `injectAs === 'env'`) or file path
   * (when `injectAs === 'file'`) into which the secret is injected.
   */
  name: string;

  /**
   * Target ids for which this binding is permitted.
   * The orchestrator rejects the binding if the resolved target id is not
   * in this list. An empty list means DENY-ALL.
   * Invariant #674: entries are target ids (routing identifiers), not node names.
   */
  permittedTargets: string[];
}

// ---------------------------------------------------------------------------
// SecretBindingRequest
// ---------------------------------------------------------------------------

/**
 * A resolve request carrying bindings + the resolved target for permission
 * checking.
 */
export interface SecretBindingRequest {
  /** Bindings to resolve. May be empty. */
  bindings: SecretBinding[];
  /**
   * Id of the resolved target. Each binding's `permittedTargets` is checked
   * against this value before the proxy is called.
   */
  targetId: string;
  /**
   * Operation kind forwarded to `CredentialProxy.acquire` as the `kind`
   * parameter (e.g. `'deploy'`).
   */
  operationKind: string;
}

// ---------------------------------------------------------------------------
// Resolved binding shapes
// ---------------------------------------------------------------------------

/**
 * A binding whose secret has been resolved into an env-var value.
 * Contains live secret material — NEVER serialize or log this type.
 */
export interface ResolvedBindingEnv {
  injectAs: "env";
  /** Env var name. */
  name: string;
  /** Resolved secret value. LIVE MATERIAL — do not log or persist. */
  value: string;
  /** SHA-256 hex of the original `credentialRef`. Safe to persist. */
  refHash: string;
}

/**
 * A binding whose secret has been resolved into file content.
 * Contains live secret material — NEVER serialize or log this type.
 */
export interface ResolvedBindingFile {
  injectAs: "file";
  /** Absolute or relative file path. */
  name: string;
  /** Resolved secret content. LIVE MATERIAL — do not log or persist. */
  content: string;
  /** SHA-256 hex of the original `credentialRef`. Safe to persist. */
  refHash: string;
}

/** Union of resolved binding shapes. */
export type ResolvedBinding = ResolvedBindingEnv | ResolvedBindingFile;

// ---------------------------------------------------------------------------
// Record-safe shape (no secret material)
// ---------------------------------------------------------------------------

/**
 * The record-safe projection of a resolved binding.
 * Contains only `refHash`, `injectAs`, and `name`. No secret material.
 * Safe to persist in `DeploymentRecord`.
 */
export interface RecordSafeBinding {
  /** `injectAs` value for audit purposes. */
  injectAs: "env" | "file";
  /** Name (env var or file path). */
  name: string;
  /** SHA-256 hex of the original `credentialRef`. */
  refHash: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result of `resolveSecretBindings`.
 *
 * `resolved` — full resolved bindings with live secret material.
 *   Use these for in-process injection only; do NOT serialize.
 *
 * `recordSafeBindings` — projection with only `refHash`, safe for
 *   persistence in `DeploymentRecord`.
 */
export interface SecretBindingResult {
  /** Resolved bindings with live secret material. Do not serialize. */
  resolved: ResolvedBinding[];
  /** Record-safe projections: only refHash, no secret material. */
  recordSafeBindings: RecordSafeBinding[];
}

// ---------------------------------------------------------------------------
// hashCredentialRef
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex hash of a `credentialRef` string.
 *
 * The hash is safe to persist (one-way; cannot recover the original ref).
 * Used as `refHash` in `DeploymentRecord` so the audit trail can detect
 * which secrets were used without exposing secret material.
 *
 * @param credentialRef - The credential reference string to hash.
 * @returns A lowercase hex SHA-256 digest.
 */
export function hashCredentialRef(credentialRef: string): string {
  return createHash("sha256").update(credentialRef, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// resolveSecretBindings
// ---------------------------------------------------------------------------

/**
 * Resolves secret bindings JIT through the injected `CredentialProxy`.
 *
 * Per-binding steps:
 *  1. Permission check: reject if `targetId` is not in `binding.permittedTargets`.
 *  2. Call `proxy.acquire(request.operationKind, 'secret', { resource: credentialRef })`.
 *  3. Extract the value from `kubeconfig` (the proxy's opaque token field).
 *  4. Build `ResolvedBinding` (live material) and `RecordSafeBinding` (hash only).
 *
 * Throws `Error` with code-readable messages on permission denial or proxy failure.
 * NEVER logs or returns secret material in error messages.
 *
 * @param request - Bindings + target id + operation kind.
 * @param proxy   - CredentialProxy implementation (real or homelab shim).
 * @returns `SecretBindingResult` with both live and record-safe projections.
 */
export async function resolveSecretBindings(
  request: SecretBindingRequest,
  proxy: CredentialProxy,
): Promise<SecretBindingResult> {
  const resolved: ResolvedBinding[] = [];
  const recordSafeBindings: RecordSafeBinding[] = [];

  for (const binding of request.bindings) {
    // Step 1: per-target permission check.
    if (!binding.permittedTargets.includes(request.targetId)) {
      throw new Error(
        `SecretBinding for '${binding.name}' is not permitted for target '${request.targetId}'. ` +
          `Permitted targets: [${binding.permittedTargets.join(", ")}]. ` +
          `Add '${request.targetId}' to the binding's permittedTargets to allow it.`,
      );
    }

    // Step 2: call the proxy JIT.
    const credential = await proxy.acquire(request.operationKind, "secret", {
      resource: binding.credentialRef,
    });

    // Step 3: extract value from the credential.
    // The proxy returns `kubeconfig` as the opaque token field; for secret
    // bindings this carries the actual secret value.
    const secretValue = credential.kubeconfig;

    // Step 4: build resolved + record-safe projections.
    const refHash = hashCredentialRef(binding.credentialRef);

    if (binding.injectAs === "env") {
      const resolvedEnv: ResolvedBindingEnv = {
        injectAs: "env",
        name: binding.name,
        value: secretValue,
        refHash,
      };
      resolved.push(resolvedEnv);
    } else {
      const resolvedFile: ResolvedBindingFile = {
        injectAs: "file",
        name: binding.name,
        content: secretValue,
        refHash,
      };
      resolved.push(resolvedFile);
    }

    // Record-safe: no secret material.
    recordSafeBindings.push({
      injectAs: binding.injectAs,
      name: binding.name,
      refHash,
    });
  }

  return { resolved, recordSafeBindings };
}
