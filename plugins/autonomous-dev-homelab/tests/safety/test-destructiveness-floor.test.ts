/**
 * 5x4 destructiveness x trust truth table for `meetsFloor` + FLOOR
 * constant assertions. SPEC-002-2-05 (TDD-002 §8).
 *
 * The truth table is GENERATED, not hand-written: as the FLOOR table
 * evolves the test naturally extends. Hand-rolled tables silently miss
 * new combinations.
 */

import {
  FLOOR,
  TRUST_RANK,
  meetsFloor,
  type Destructiveness,
  type TrustLevel,
} from '../../src/safety/destructiveness';

const LEVELS: Destructiveness[] = [
  'read-only',
  'reversible',
  'persistent-modifying',
  'data-affecting',
  'architectural',
];
const TRUSTS: TrustLevel[] = ['L0', 'L1', 'L2', 'L3'];

describe('FLOOR mapping (TDD §8)', () => {
  it('maps read-only to L3', () => expect(FLOOR['read-only']).toBe('L3'));
  it('maps reversible to L1', () => expect(FLOOR['reversible']).toBe('L1'));
  it('maps persistent-modifying to L0', () =>
    expect(FLOOR['persistent-modifying']).toBe('L0'));
  it('maps data-affecting to L0', () =>
    expect(FLOOR['data-affecting']).toBe('L0'));
  it('maps architectural to L0', () =>
    expect(FLOOR['architectural']).toBe('L0'));

  it('FLOOR is frozen', () => {
    expect(Object.isFrozen(FLOOR)).toBe(true);
  });

  it('TRUST_RANK is frozen with the expected ordering', () => {
    expect(Object.isFrozen(TRUST_RANK)).toBe(true);
    expect(TRUST_RANK.L0).toBeLessThan(TRUST_RANK.L1);
    expect(TRUST_RANK.L1).toBeLessThan(TRUST_RANK.L2);
    expect(TRUST_RANK.L2).toBeLessThan(TRUST_RANK.L3);
  });
});

describe('meetsFloor truth table (5 destructiveness x 4 trust = 20 cases)', () => {
  for (const dest of LEVELS) {
    for (const trust of TRUSTS) {
      const required = FLOOR[dest];
      const expected = TRUST_RANK[trust] <= TRUST_RANK[required];
      it(`${dest} configured at ${trust}: ${expected ? 'allowed' : 'denied'}`, () => {
        expect(meetsFloor(trust, required)).toBe(expected);
      });
    }
  }
});

describe('meetsFloor edge cases', () => {
  it('equal trust levels meet the floor (L3 vs L3)', () => {
    expect(meetsFloor('L3', 'L3')).toBe(true);
  });
  it('strictly stricter trust meets a permissive floor (L0 vs L3)', () => {
    expect(meetsFloor('L0', 'L3')).toBe(true);
  });
  it('strictly more permissive trust does not meet a strict floor (L3 vs L0)', () => {
    expect(meetsFloor('L3', 'L0')).toBe(false);
  });
});
