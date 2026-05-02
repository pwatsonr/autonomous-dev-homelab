/**
 * Shared types for the SSH certificate authority. Implements
 * SPEC-001-2-01 §"`src/ca/types.ts`".
 */

export type PassphraseSource = 'env' | 'stored' | 'prompt';

export interface CertificateMetadata {
  platformId: string;
  principal: string;
  validBefore: string; // ISO-8601
  fingerprint: string;
  revoked: boolean;
}

export interface RevocationEntry {
  platformId: string;
  fingerprint: string;
  revokedAt: string; // ISO-8601
}

export interface RotationResult {
  oldFingerprint: string;
  newFingerprint: string;
  revokedAt: string;
}

/** Thrown by SSHCertificateManager and PassphraseProvider error paths. */
export class CAError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CAError';
    this.code = code;
  }
}

export class CAAlreadyExistsError extends CAError {
  constructor(message = 'CA already initialized') {
    super('CA_ALREADY_EXISTS', message);
    this.name = 'CAAlreadyExistsError';
  }
}

export class PassphraseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassphraseUnavailableError';
  }
}
