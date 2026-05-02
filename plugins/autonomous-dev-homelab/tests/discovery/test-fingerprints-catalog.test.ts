/**
 * Catalog regression tests: one assertion per platform fingerprint.
 *
 * Each test feeds a known-good response body through the same matcher
 * the prober uses, and asserts the fingerprint matches. A negative test
 * (generic nginx welcome page) confirms each fingerprint also rejects
 * unrelated content.
 */

import { PLATFORM_FINGERPRINTS } from '../../src/discovery/fingerprints';
import { jsonPathLookup } from '../../src/discovery/json-path';
import type { ExpectedResponse, Fingerprint } from '../../src/discovery/types';

const GENERIC_NGINX_HTML =
  '<html><head><title>Welcome to nginx!</title></head><body>nginx is working.</body></html>';

function evaluate(body: string, expected: ExpectedResponse): boolean {
  if (expected.kind === 'regex') {
    try {
      return new RegExp(expected.pattern, expected.flags).test(body);
    } catch {
      return false;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  let value: unknown;
  try {
    value = jsonPathLookup(parsed, expected.path);
  } catch {
    return false;
  }
  if (expected.exists === true) return value !== undefined;
  if ('equals' in expected) return value === expected.equals;
  return false;
}

interface CatalogCase {
  type: string;
  positive: string;
}

const POSITIVES: Record<string, string> = {
  unraid: '<html><head><title>Unraid</title></head><body>/webGui/styles/foo.css</body></html>',
  'proxmox-ve': '{"data":{"version":"8.1.4","release":"8.1","repoid":"abc"}}',
  docker: 'OK',
  kubernetes: '{"major":"1","minor":"29","gitVersion":"v1.29.0"}',
  'docker-swarm': '{"Swarm":{"NodeID":"abc123"}}',
  unifi: '<html>UniFi Network — Sign in</html>',
  truenas: '{"system_serial":"AB-CDEF-1234"}',
};

describe('PLATFORM_FINGERPRINTS catalog', () => {
  test('catalog contains 7 entries with confidence in [0.85, 0.99]', () => {
    expect(PLATFORM_FINGERPRINTS).toHaveLength(7);
    for (const fp of PLATFORM_FINGERPRINTS) {
      expect(fp.expectedResponse.confidence).toBeGreaterThanOrEqual(0.85);
      expect(fp.expectedResponse.confidence).toBeLessThanOrEqual(0.99);
    }
  });

  test.each(PLATFORM_FINGERPRINTS.map((fp) => [fp.platformType, fp]))(
    '%s fingerprint matches a known-good fixture and rejects nginx',
    (type: string, fp: Fingerprint) => {
      const positive = POSITIVES[type];
      expect(positive).toBeDefined();
      expect(evaluate(positive!, fp.expectedResponse)).toBe(true);
      expect(evaluate(GENERIC_NGINX_HTML, fp.expectedResponse)).toBe(false);
    },
  );
});
