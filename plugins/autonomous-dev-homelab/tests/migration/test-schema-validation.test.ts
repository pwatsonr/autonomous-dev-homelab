/**
 * `migration-v1.json` schema validation. SPEC-002-2-05.
 *
 * Loads the schema, validates the TDD §10 fixture (must accept), then
 * exercises the field-level rejection cases per the spec acceptance.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'schemas',
  'migration-v1.json',
);
const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'migration-tdd-section-10-example.json',
);

interface MigrationDoc {
  migration_id: string;
  source_platform: string;
  target_platform: string;
  classification: string;
  description: string;
  initiated_by: string;
  initiated_at: string;
  approval_delay_seconds: number;
  requires_typed_confirm: boolean;
  phases: { name: string; status: string }[];
}

async function loadValidator(): Promise<(d: unknown) => boolean> {
  const schemaJson = JSON.parse(await fs.readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schemaJson);
}

async function loadFixture(): Promise<MigrationDoc> {
  return JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
}

describe('migration-v1.json schema', () => {
  it('accepts the TDD §10 fixture', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    const ok = validate(fixture);
    expect(ok).toBe(true);
  });

  it('rejects when migration_id is missing', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    const { migration_id: _drop, ...rest } = fixture;
    expect(validate(rest)).toBe(false);
  });

  it('rejects classification != "architectural"', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, classification: 'reversible' })).toBe(false);
  });

  it('rejects requires_typed_confirm: false', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, requires_typed_confirm: false })).toBe(false);
  });

  it('rejects phases with the wrong length (< 5)', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, phases: fixture.phases.slice(0, 4) })).toBe(false);
  });

  it('rejects phases with the wrong length (> 5)', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(
      validate({
        ...fixture,
        phases: [...fixture.phases, { name: 'execute', status: 'pending' }],
      }),
    ).toBe(false);
  });

  it('rejects approval_delay_seconds < 3600', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, approval_delay_seconds: 60 })).toBe(false);
  });

  it('rejects a malformed migration_id (not 26-char Crockford base32)', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, migration_id: 'not-a-ulid' })).toBe(false);
  });

  it('rejects an unknown phase name', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    const phases = fixture.phases.slice();
    phases[0] = { name: 'mystery-phase', status: 'pending' };
    expect(validate({ ...fixture, phases })).toBe(false);
  });

  it('rejects additional top-level properties', async () => {
    const validate = await loadValidator();
    const fixture = await loadFixture();
    expect(validate({ ...fixture, surprise: 'extra' })).toBe(false);
  });
});
