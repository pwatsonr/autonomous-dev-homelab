/**
 * inventory-v1.json schema validation tests.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schemaJson from '../../schemas/inventory-v1.json';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schemaJson);

describe('inventory-v1 schema', () => {
  test('accepts the canonical fixture', async () => {
    const raw = await fs.readFile(
      path.join(__dirname, '..', 'fixtures', 'inventory', 'valid.yaml'),
      'utf8',
    );
    const parsed = yaml.load(raw);
    expect(validate(parsed)).toBe(true);
  });

  test('rejects unknown platform type', () => {
    const bad = {
      version: '1.0',
      platforms: [
        {
          id: 'wat-1',
          type: 'gizmo',
          host: 'x',
          port: 1,
          discovered_at: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z',
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects port out of range', () => {
    const bad = {
      version: '1.0',
      platforms: [
        {
          id: 'p1',
          type: 'docker',
          host: 'x',
          port: 0, // < 1
          discovered_at: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z',
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects id with uppercase letters', () => {
    const bad = {
      version: '1.0',
      platforms: [
        {
          id: 'BAD-Id',
          type: 'docker',
          host: 'x',
          port: 1,
          discovered_at: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z',
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects extra top-level keys (additionalProperties: false)', () => {
    const bad = { version: '1.0', platforms: [], extra: 'nope' };
    expect(validate(bad)).toBe(false);
  });

  test('accepts entry with metadata and connection', () => {
    const ok = {
      version: '1.0',
      platforms: [
        {
          id: 'docker-10-0-0-1',
          type: 'docker',
          host: '10.0.0.1',
          port: 2375,
          discovered_at: '2026-01-01T00:00:00Z',
          last_seen: '2026-01-01T00:00:00Z',
          metadata: { confidence: 0.95, region: 'home' },
          connection: { ssh_cert_path: '/etc/keys/foo.cert' },
        },
      ],
    };
    expect(validate(ok)).toBe(true);
  });
});
