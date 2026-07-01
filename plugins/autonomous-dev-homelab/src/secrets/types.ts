/**
 * Secret resolver types for the homelab plugin.
 * SPEC: REQ-000055 §2.4.
 *
 * `ResolvedSecret` holds the raw key material in memory only; it MUST NOT
 * be serialized, logged, or written to any audit record. Only `refHash`
 * is safe to log.
 */

import type { CredentialRef } from '../config/types.js';

export interface ResolvedSecret {
  /** Raw material — memory only, zeroed on Runtime shutdown. */
  readonly value: Buffer;
  /**
   * SHA-256("vault:" + path + ":" + field + ":" + version), hex-encoded,
   * prefixed "sha256:". Safe to log in audit events.
   */
  readonly refHash: string;
  /** Vault path + field, safe to log verbatim. */
  readonly ref: CredentialRef;
}

export interface SecretResolver {
  resolve(ref: CredentialRef): Promise<ResolvedSecret>;
  /** Health check. Throws on unreachable/auth failure. */
  ping(): Promise<void>;
}
