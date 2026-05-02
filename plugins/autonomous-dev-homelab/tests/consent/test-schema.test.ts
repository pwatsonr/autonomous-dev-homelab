/**
 * network-consent-v1.json schema validation tests.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schemaJson from '../../schemas/network-consent-v1.json';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schemaJson);

describe('network-consent-v1 schema', () => {
  test('accepts the canonical valid fixture', async () => {
    const raw = await fs.readFile(
      path.join(__dirname, '..', 'fixtures', 'consent', 'valid.yaml'),
      'utf8',
    );
    const parsed = yaml.load(raw);
    expect(validate(parsed)).toBe(true);
  });

  test('accepts the expired-but-still-structurally-valid fixture', async () => {
    const raw = await fs.readFile(
      path.join(__dirname, '..', 'fixtures', 'consent', 'expired.yaml'),
      'utf8',
    );
    const parsed = yaml.load(raw);
    // expired.yaml is structurally valid; expiry is a runtime check.
    expect(validate(parsed)).toBe(true);
  });

  test('rejects non-1.0 version', () => {
    const bad = { version: '0.9', consents: [] };
    expect(validate(bad)).toBe(false);
  });

  test('rejects malformed CIDR', () => {
    const bad = {
      version: '1.0',
      consents: [
        {
          cidr: 'not-a-cidr',
          approved_at: '2026-04-28T00:00:00Z',
          expires_at: '2126-04-28T00:00:00Z',
          permitted_ports: [443],
          permitted_scan_types: ['http_probe'],
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects unknown scan type', () => {
    const bad = {
      version: '1.0',
      consents: [
        {
          cidr: '192.168.1.0/24',
          approved_at: '2026-04-28T00:00:00Z',
          expires_at: '2126-04-28T00:00:00Z',
          permitted_ports: [443],
          permitted_scan_types: ['nmap_scan'], // not in enum
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects empty permitted_ports (minItems: 1)', () => {
    const bad = {
      version: '1.0',
      consents: [
        {
          cidr: '192.168.1.0/24',
          approved_at: '2026-04-28T00:00:00Z',
          expires_at: '2126-04-28T00:00:00Z',
          permitted_ports: [],
          permitted_scan_types: ['http_probe'],
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });

  test('rejects port out of range', () => {
    const bad = {
      version: '1.0',
      consents: [
        {
          cidr: '192.168.1.0/24',
          approved_at: '2026-04-28T00:00:00Z',
          expires_at: '2126-04-28T00:00:00Z',
          permitted_ports: [70000],
          permitted_scan_types: ['http_probe'],
        },
      ],
    };
    expect(validate(bad)).toBe(false);
  });
});
