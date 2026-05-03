/**
 * HMAC sign/verify helper tests. SPEC-002-2-05.
 *
 * Covers:
 *   - sign/verify roundtrip;
 *   - tampered payload rejected;
 *   - tampered hmac rejected;
 *   - secret-env unset throws;
 *   - secret-env < 32 chars throws;
 *   - deterministic signature for same input.
 */

import { signPayload, verifyPayload } from '../../src/safety/hmac';
import { setupSafetyEnv, teardownSafetyEnv, type SafetyEnv } from '../helpers/safety-env';

describe('hmac sign/verify', () => {
  let env: SafetyEnv;

  beforeEach(() => {
    env = setupSafetyEnv('hmac-test-');
  });

  afterEach(() => {
    teardownSafetyEnv(env);
  });

  it('roundtrip: signed payload verifies', () => {
    const signed = signPayload({ a: 1, b: 'two', c: [3, 4] });
    expect(verifyPayload(signed)).toBe(true);
    expect(typeof signed.hmac).toBe('string');
    expect(signed.hmac).toMatch(/^[0-9a-f]+$/);
  });

  it('tampered payload is rejected (mutation post-sign)', () => {
    const signed = signPayload({ a: 1 });
    const tampered = { payload: { a: 2 }, hmac: signed.hmac };
    expect(verifyPayload(tampered)).toBe(false);
  });

  it('tampered hmac is rejected', () => {
    const signed = signPayload({ a: 1 });
    const flipped = signed.hmac.startsWith('a')
      ? 'b' + signed.hmac.slice(1)
      : 'a' + signed.hmac.slice(1);
    expect(verifyPayload({ payload: { a: 1 }, hmac: flipped })).toBe(false);
  });

  it('signing throws when HOMELAB_HMAC_SECRET is unset', () => {
    const prev = process.env['HOMELAB_HMAC_SECRET'];
    delete process.env['HOMELAB_HMAC_SECRET'];
    try {
      expect(() => signPayload({ a: 1 })).toThrow(/HOMELAB_HMAC_SECRET/);
    } finally {
      if (prev !== undefined) process.env['HOMELAB_HMAC_SECRET'] = prev;
    }
  });

  it('signing throws when HOMELAB_HMAC_SECRET is shorter than 32 chars', () => {
    const prev = process.env['HOMELAB_HMAC_SECRET'];
    process.env['HOMELAB_HMAC_SECRET'] = 'too-short';
    try {
      expect(() => signPayload({ a: 1 })).toThrow(/>= 32 chars/);
    } finally {
      if (prev !== undefined) process.env['HOMELAB_HMAC_SECRET'] = prev;
      else delete process.env['HOMELAB_HMAC_SECRET'];
    }
  });

  it('signature is deterministic for the same input + same key ordering', () => {
    const a = signPayload({ x: 1, y: 2 });
    const b = signPayload({ y: 2, x: 1 }); // canonicalizer sorts keys
    expect(a.hmac).toBe(b.hmac);
  });

  it('verifyPayload returns false for malformed envelopes', () => {
    expect(verifyPayload({ payload: { a: 1 }, hmac: 'not-hex!' })).toBe(false);
    // Length mismatch (very short hex).
    expect(verifyPayload({ payload: { a: 1 }, hmac: 'ab' })).toBe(false);
  });
});
