/**
 * SPEC-002-1-01 — observation-v1 JSON schema tests.
 * Validates that fixture observations round-trip through ajv and that
 * required-field / enum / format violations are rejected.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import schema from '../../schemas/observation-v1.json';
import type { Observation } from '../../src/observation/types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate: ValidateFunction = ajv.compile(schema);

function baseObservation(): Observation {
  return {
    id: randomUUID(),
    platform: 'k3s-01',
    pattern: 'oom_kill',
    resource: 'Pod/web-7c',
    severity: 'P1',
    discovered_at: '2026-05-02T12:00:00.000Z',
  };
}

describe('observation-v1.json schema', () => {
  test('compiles as draft-07', () => {
    expect(validate).toBeInstanceOf(Function);
  });

  test('accepts a fully populated valid observation', () => {
    const obs: Observation = {
      ...baseObservation(),
      details: { count: 3, message: 'Container exceeded memory limit' },
      dedup_key: 'k3s-01:oom_kill:Pod/web-7c',
    };
    expect(validate(obs)).toBe(true);
  });

  test('accepts a minimal valid observation (no details, no dedup_key)', () => {
    expect(validate(baseObservation())).toBe(true);
  });

  test.each(['id', 'platform', 'pattern', 'resource', 'severity', 'discovered_at'] as const)(
    'rejects missing required field "%s" with a schema error naming it',
    (field) => {
      const obs = { ...baseObservation() } as Record<string, unknown>;
      delete obs[field];
      expect(validate(obs)).toBe(false);
      const errs = validate.errors ?? [];
      const found = errs.some(
        (e) =>
          (e.params as { missingProperty?: string }).missingProperty === field ||
          e.message?.includes(field),
      );
      expect(found).toBe(true);
    },
  );

  test('rejects unknown pattern value', () => {
    const obs = { ...baseObservation(), pattern: 'unknown_pattern' };
    expect(validate(obs)).toBe(false);
    const errs = validate.errors ?? [];
    expect(errs.some((e) => e.keyword === 'enum')).toBe(true);
  });

  test('rejects malformed discovered_at', () => {
    const obs = { ...baseObservation(), discovered_at: 'not-a-date' };
    expect(validate(obs)).toBe(false);
    const errs = validate.errors ?? [];
    expect(errs.some((e) => e.keyword === 'format')).toBe(true);
  });

  test('rejects unknown severity', () => {
    const obs = { ...baseObservation(), severity: 'P9' };
    expect(validate(obs)).toBe(false);
  });

  test('rejects additional unknown top-level properties', () => {
    const obs = { ...baseObservation(), extra: 'nope' };
    expect(validate(obs)).toBe(false);
  });
});
