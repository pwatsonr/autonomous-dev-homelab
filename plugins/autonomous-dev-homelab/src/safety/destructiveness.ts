/**
 * Destructiveness ladder per TDD-002 §8 (BINDING — homelab PRD §25.2).
 *
 * Each operation MUST be classified into exactly one of these levels.
 * The classification drives the minimum required trust-level floor.
 * Any change to FLOOR is a TDD §8 change; it is NOT a config tweak.
 *
 * Implements SPEC-002-2-01.
 */

/** Five destructiveness levels per TDD-002 §8. */
export type Destructiveness =
  | 'read-only'
  | 'reversible'
  | 'persistent-modifying'
  | 'data-affecting'
  | 'architectural';

/**
 * Trust levels per autonomous-dev PRD-009.
 * L3 = full automation; L0 = strict per-action operator approval.
 */
export type TrustLevel = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * FLOOR mapping per TDD-002 §8.
 *
 * Each destructiveness level has a MINIMUM required trust level. Operators
 * MAY configure a level HIGHER (more friction, e.g. L0 when L1 is the floor);
 * they MAY NOT configure a level LOWER (less friction). The validator
 * (`validateOperatorConfig`) enforces this at config-load time.
 *
 * "Strictness" ordering: L0 (strictest) < L1 < L2 < L3 (most permissive).
 * Floor `read-only=L3` means "any trust level is OK" (read-only ops are safe
 * to auto-execute even at L3). Floor `architectural=L0` means "must be L0".
 */
export const FLOOR: Readonly<Record<Destructiveness, TrustLevel>> = Object.freeze({
  'read-only': 'L3',
  reversible: 'L1',
  'persistent-modifying': 'L0',
  'data-affecting': 'L0',
  architectural: 'L0',
});

/**
 * Numeric ordering for floor comparison. Higher number = more permissive.
 * L0 = strictest (0), L3 = most permissive (3).
 */
export const TRUST_RANK: Readonly<Record<TrustLevel, number>> = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
});

/**
 * Returns true iff `configured` is at-or-stricter-than `required`.
 *
 * "configured meets the floor" means configured's rank is <= required's rank.
 * Example: `meetsFloor('L0', 'L1')` → true (L0 is stricter than the L1 floor).
 *          `meetsFloor('L3', 'L0')` → false (L3 is too permissive for an L0 floor).
 *          `meetsFloor('L3', 'L3')` → true (equal).
 */
export function meetsFloor(configured: TrustLevel, required: TrustLevel): boolean {
  return TRUST_RANK[configured] <= TRUST_RANK[required];
}
