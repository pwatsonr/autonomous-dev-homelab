/**
 * `validateOperatorConfig` truth-table coverage. SPEC-002-2-05.
 *
 * Generates the 20-case 5x4 destructiveness x trust matrix plus
 * missing-config edge cases. Mirrors the `meetsFloor` test so any FLOOR
 * change drops out of both suites consistently.
 */

import { validateOperatorConfig } from '../../src/safety/validator';
import {
  FLOOR,
  TRUST_RANK,
  type Destructiveness,
  type TrustLevel,
} from '../../src/safety/destructiveness';
import { ConfigurationError } from '../../src/safety/errors';
import type { OperatorConfig } from '../../src/safety/types';

const LEVELS: Destructiveness[] = [
  'read-only',
  'reversible',
  'persistent-modifying',
  'data-affecting',
  'architectural',
];
const TRUSTS: TrustLevel[] = ['L0', 'L1', 'L2', 'L3'];

function configWith(level: Destructiveness, trust: TrustLevel): OperatorConfig {
  const cfg: Record<Destructiveness, TrustLevel> = {
    'read-only': 'L3',
    reversible: 'L1',
    'persistent-modifying': 'L0',
    'data-affecting': 'L0',
    architectural: 'L0',
  };
  cfg[level] = trust;
  return { auto_approval: cfg };
}

describe('validateOperatorConfig (5x4 = 20 cases)', () => {
  for (const dest of LEVELS) {
    for (const trust of TRUSTS) {
      const required = FLOOR[dest];
      const meets = TRUST_RANK[trust] <= TRUST_RANK[required];
      it(`auto_approval.${dest}=${trust} ${meets ? 'accepts' : 'throws CONFIG_BELOW_FLOOR'}`, () => {
        if (meets) {
          expect(() => validateOperatorConfig(configWith(dest, trust))).not.toThrow();
        } else {
          let thrown: unknown;
          try {
            validateOperatorConfig(configWith(dest, trust));
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(ConfigurationError);
          const err = thrown as ConfigurationError;
          expect(err.code).toBe('CONFIG_BELOW_FLOOR');
          expect(err.details.destructiveness).toBe(dest);
          expect(err.details.configured).toBe(trust);
          expect(err.details.floor).toBe(required);
        }
      });
    }
  }
});

describe('validator edge cases', () => {
  it('throws ConfigurationError on entirely missing auto_approval entries', () => {
    expect(() =>
      validateOperatorConfig({ auto_approval: {} as Record<Destructiveness, TrustLevel> }),
    ).toThrow(ConfigurationError);
  });

  it('throws on a single missing key (data-affecting omitted)', () => {
    const cfg: OperatorConfig = {
      auto_approval: {
        'read-only': 'L3',
        reversible: 'L1',
        'persistent-modifying': 'L0',
        // 'data-affecting': missing
        architectural: 'L0',
      } as Record<Destructiveness, TrustLevel>,
    };
    let thrown: unknown;
    try {
      validateOperatorConfig(cfg);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details.destructiveness).toBe('data-affecting');
    expect((thrown as ConfigurationError).details.configured).toBe('undefined');
  });

  it('accepts a fully-floor-strict config', () => {
    expect(() =>
      validateOperatorConfig({
        auto_approval: {
          'read-only': 'L0',
          reversible: 'L0',
          'persistent-modifying': 'L0',
          'data-affecting': 'L0',
          architectural: 'L0',
        },
      }),
    ).not.toThrow();
  });

  it('error message references TDD §8', () => {
    let thrown: unknown;
    try {
      validateOperatorConfig(configWith('architectural', 'L3'));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain('TDD §8');
  });
});
