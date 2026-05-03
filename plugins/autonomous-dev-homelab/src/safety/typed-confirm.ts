/**
 * Typed-CONFIRM modal stub for SPEC-002-2-01. The real implementation
 * lands in SPEC-002-2-02; this module exists so `gate.ts` can import its
 * collaborator by name and tests can mock it.
 */

export interface TypedConfirmInput {
  message: string;
  ttl_seconds: number;
  expectedWord?: string;
}

export async function typedConfirmModal(_input: TypedConfirmInput): Promise<boolean> {
  throw new Error('NOT_IMPLEMENTED: typedConfirmModal — real impl lands in SPEC-002-2-02');
}
