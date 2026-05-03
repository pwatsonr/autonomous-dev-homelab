/**
 * Backup verification stub for SPEC-002-2-01. The real implementation
 * (manifest read, freshness rules, HMAC verify) lands in SPEC-002-2-04.
 * This module exists so `gate.ts` can import its collaborator by name
 * and tests can mock it.
 */

export interface VerifyInput {
  platform: string;
  target: string;
  freshnessOverrides?: Record<string, number>;
}

export interface BackupVerificationResult {
  ok: true;
  /** Manifest entry; shape pinned in SPEC-002-2-04. */
  entry: unknown;
}

export async function verifyBackup(_input: VerifyInput): Promise<BackupVerificationResult> {
  throw new Error('NOT_IMPLEMENTED: verifyBackup — real impl lands in SPEC-002-2-04');
}
