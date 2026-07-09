/**
 * Tests for `src/rules/policy-generator.ts` (issue #34).
 *
 * Verifies:
 *   - Generated document validates against deploy-policy-v1.json (AJV).
 *   - All rule `when` predicates key on tags/roles/env — no machine names.
 *   - All expected invariant rules are present.
 *   - Topology-derived rules appear only when the relevant topology is present.
 *   - FLOOR-tighten-only invariant: no rule in the generated document
 *     loosens the FLOOR (i.e., no rule lowers approval requirements for
 *     prod/data-affecting actions).
 */

import * as path from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import policySchemaJson from '../fixtures/deploy-policy-v1.json';
import { PolicyGenerator, type PolicyDocument, type PolicyRule } from '../../src/rules/policy-generator';
import type { TopologyDescriptor } from '../../src/rules/topology';

// ---------------------------------------------------------------------------
// AJV setup
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatePolicy: ValidateFunction = ajv.compile(policySchemaJson);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyTopology(now = '2026-01-01T00:00:00.000Z'): TopologyDescriptor {
  return { generated_at: now, nodes: [] };
}

function topologyWithManagerNode(): TopologyDescriptor {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'node-a',
        name: 'node-a',
        kind: 'node',
        role: 'manager',
        env_tier: 'infra',
        capability_tags: ['manager'],
        hosted_service_roles: [],
      },
    ],
  };
}

function topologyWithStorageNode(): TopologyDescriptor {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'nas-x',
        name: 'nas-x',
        kind: 'platform',
        role: 'storage',
        env_tier: 'prod',
        capability_tags: ['array', 'storage', 'worker'],
        hosted_service_roles: [],
      },
    ],
  };
}

function topologyWithProdNode(): TopologyDescriptor {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'worker-prod',
        name: 'worker-prod',
        kind: 'node',
        role: 'compute',
        env_tier: 'prod',
        capability_tags: ['worker'],
        hosted_service_roles: ['media'],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('PolicyGenerator schema validation', () => {
  const generator = new PolicyGenerator();

  test('empty topology → validates against deploy-policy-v1.json', () => {
    const doc = generator.generate(emptyTopology());
    const valid = validatePolicy(doc);
    if (!valid) {
      console.error('AJV errors:', validatePolicy.errors);
    }
    expect(valid).toBe(true);
  });

  test('topology with manager node → validates against deploy-policy-v1.json', () => {
    const doc = generator.generate(topologyWithManagerNode());
    expect(validatePolicy(doc)).toBe(true);
  });

  test('topology with storage node → validates against deploy-policy-v1.json', () => {
    const doc = generator.generate(topologyWithStorageNode());
    expect(validatePolicy(doc)).toBe(true);
  });

  test('topology with prod node → validates against deploy-policy-v1.json', () => {
    const doc = generator.generate(topologyWithProdNode());
    expect(validatePolicy(doc)).toBe(true);
  });

  test('version is exactly "1.0"', () => {
    const doc = generator.generate(emptyTopology());
    expect(doc.version).toBe('1.0');
  });
});

// ---------------------------------------------------------------------------
// Invariant rules present
// ---------------------------------------------------------------------------

describe('PolicyGenerator invariant rules', () => {
  const generator = new PolicyGenerator();
  let doc: PolicyDocument;

  beforeEach(() => {
    doc = generator.generate(emptyTopology());
  });

  test('no-workloads-on-manager rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'no-workloads-on-manager');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.when).toMatchObject({ capability: 'manager' });
  });

  test('gpu-required-for-media rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'gpu-required-for-media');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.when).toMatchObject({ tag: { key: 'role', value: 'media' } });
  });

  test('media-anti-affinity rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'media-anti-affinity');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
  });

  test('arr-stack-anti-affinity rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'arr-stack-anti-affinity');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.when).toMatchObject({ tag: { key: 'role', value: 'arr-stack' } });
  });

  test('prod-approval rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'prod-approval');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('require-approval');
    expect(rule!.when).toMatchObject({ env: 'prod' });
  });

  test('prod-maintenance-window rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'prod-maintenance-window');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.when).toMatchObject({ env: 'prod' });
    expect(rule!.type).toBe('maintenance-window');
  });

  test('blast-radius-cap rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'blast-radius-cap');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.type).toBe('blast-radius');
    expect((rule!.params as Record<string, unknown>)['maxTargets']).toBe(3);
  });

  test('destructiveness-floor rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'destructiveness-floor');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('require-approval');
  });

  test('infra-env-approval rule is present', () => {
    const rule = doc.rules.find((r) => r.id === 'infra-env-approval');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('require-approval');
    expect(rule!.when).toMatchObject({ env: 'infra' });
  });
});

// ---------------------------------------------------------------------------
// Invariant #62: rules key on tags/roles/env, never on instance names
// ---------------------------------------------------------------------------

describe('Invariant #62: rules key on tags/roles/env only', () => {
  const generator = new PolicyGenerator();

  /**
   * Collect all string literal values in a rule's `when` predicate and
   * `params` that could be instance identifiers. A rule must never reference
   * a machine name, hostname, or service instance id.
   *
   * We verify this by checking that when.kind, when.env, when.capability,
   * when.tag.value, and when.tag.key are all generic capability/role/env
   * strings — NOT patterns that look like hostnames (lowercase + digits +
   * hyphens that resemble a specific machine name).
   *
   * The heuristic: any string value containing a digit followed by two
   * more digits (e.g. "node01", "gallifrey-lab-01") is likely a machine
   * name. Generic values (e.g. "prod", "manager", "media", "gpu") pass.
   */
  function looksLikeMachineName(value: string): boolean {
    // hostname pattern: letters/hyphens mixed with 2+ digit suffixes
    return /[a-z]-?\d{2,}$/.test(value) || /^[a-z]+-\d+$/.test(value);
  }

  function extractWhenStrings(rule: PolicyRule): string[] {
    const values: string[] = [];
    const when = rule.when;
    if (when === undefined) return values;
    if (typeof when.kind === 'string') values.push(when.kind);
    if (typeof when.env === 'string') values.push(when.env);
    if (typeof when.capability === 'string') values.push(when.capability);
    if (when.tag !== undefined) {
      values.push(when.tag.key);
      values.push(when.tag.value);
    }
    return values;
  }

  test('no when-predicate value looks like a machine name', () => {
    const doc = generator.generate(emptyTopology());
    for (const rule of doc.rules) {
      for (const val of extractWhenStrings(rule)) {
        expect(looksLikeMachineName(val)).toBe(false);
      }
    }
  });

  test('topology-derived rules also use only generic predicates', () => {
    const doc = generator.generate(topologyWithStorageNode());
    for (const rule of doc.rules) {
      for (const val of extractWhenStrings(rule)) {
        expect(looksLikeMachineName(val)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FLOOR-tighten-only invariant
// ---------------------------------------------------------------------------

describe('FLOOR tighten-only invariant', () => {
  const generator = new PolicyGenerator();

  /**
   * The homelab rules MUST only tighten (never loosen) the core FLOOR.
   *
   * We verify by checking:
   *   1. The `destructiveness-floor` rule uses effect=`require-approval`, NOT `allow`.
   *   2. No rule targeting env=`prod` has effect=`allow` (which would loosen the
   *      prod-approval requirement).
   *   3. No rule produces effect=`allow` on the capability=`manager` predicate
   *      (which would loosen the deny on manager workloads).
   */
  test('destructiveness-floor rule uses require-approval, not allow', () => {
    const doc = generator.generate(emptyTopology());
    const rule = doc.rules.find((r) => r.id === 'destructiveness-floor');
    expect(rule!.effect).not.toBe('allow');
    expect(rule!.effect).toBe('require-approval');
  });

  test('no prod-env rule has effect=allow (would loosen prod gate)', () => {
    const doc = generator.generate(topologyWithProdNode());
    const prodAllowRules = doc.rules.filter(
      (r) => r.when?.env === 'prod' && r.effect === 'allow',
    );
    expect(prodAllowRules).toHaveLength(0);
  });

  test('no manager-capability rule has effect=allow (would loosen no-workloads guard)', () => {
    const doc = generator.generate(topologyWithManagerNode());
    const managerAllowRules = doc.rules.filter(
      (r) => r.when?.capability === 'manager' && r.effect === 'allow',
    );
    expect(managerAllowRules).toHaveLength(0);
  });

  test('blast-radius-cap maxTargets is 3 or less (never loosened)', () => {
    const doc = generator.generate(emptyTopology());
    const rule = doc.rules.find((r) => r.id === 'blast-radius-cap');
    expect((rule!.params as { maxTargets: number }).maxTargets).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Topology-derived rules
// ---------------------------------------------------------------------------

describe('PolicyGenerator topology-derived rules', () => {
  const generator = new PolicyGenerator();

  test('storage-array-protection present when storage node exists', () => {
    const doc = generator.generate(topologyWithStorageNode());
    const rule = doc.rules.find((r) => r.id === 'storage-array-protection');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('require-approval');
    expect(rule!.when).toMatchObject({ capability: 'storage' });
  });

  test('storage-array-protection absent when no storage node', () => {
    const doc = generator.generate(emptyTopology());
    const rule = doc.rules.find((r) => r.id === 'storage-array-protection');
    expect(rule).toBeUndefined();
  });

  test('prod-concurrent-deploy-quota present when prod node exists', () => {
    const doc = generator.generate(topologyWithProdNode());
    const rule = doc.rules.find((r) => r.id === 'prod-concurrent-deploy-quota');
    expect(rule).toBeDefined();
    expect(rule!.effect).toBe('deny');
    expect(rule!.type).toBe('quota');
    expect(rule!.when).toMatchObject({ env: 'prod' });
  });

  test('prod-concurrent-deploy-quota absent when no prod node', () => {
    const doc = generator.generate(emptyTopology());
    const rule = doc.rules.find((r) => r.id === 'prod-concurrent-deploy-quota');
    expect(rule).toBeUndefined();
  });

  test('rule count grows when topology has storage + prod nodes', () => {
    const emptyDoc = generator.generate(emptyTopology());
    const richDoc = generator.generate(topologyWithProdNode());
    expect(richDoc.rules.length).toBeGreaterThan(emptyDoc.rules.length);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('PolicyGenerator determinism', () => {
  const generator = new PolicyGenerator();

  test('same topology → same document (idempotent)', () => {
    const t = emptyTopology('2026-01-01T00:00:00.000Z');
    const doc1 = generator.generate(t);
    const doc2 = generator.generate(t);
    expect(JSON.stringify(doc1)).toBe(JSON.stringify(doc2));
  });
});
