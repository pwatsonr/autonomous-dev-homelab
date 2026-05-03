/**
 * Unit tests for the audit-log canonical JSON encoder. SPEC-001-3-02.
 * Verifies determinism (sorted keys, no whitespace) and rejection of
 * non-JSON-serializable values.
 */

import { canonicalJson } from '../../src/audit/canonical-json';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically at every depth', () => {
    const out = canonicalJson({ b: { d: 1, c: 2 }, a: 0 });
    expect(out).toBe('{"a":0,"b":{"c":2,"d":1}}');
  });

  it('emits no whitespace', () => {
    const out = canonicalJson({ a: [1, 2, { c: 'x' }] });
    expect(out).toBe('{"a":[1,2,{"c":"x"}]}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });

  it('rejects undefined / function / symbol / BigInt', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol('x'))).toThrow(TypeError);
    expect(() => canonicalJson(1n)).toThrow(TypeError);
  });

  it('rejects objects with undefined values', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined value at key 'a'/);
  });
});
