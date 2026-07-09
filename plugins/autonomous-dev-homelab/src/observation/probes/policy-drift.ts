/**
 * `PolicyDriftProbe`: compares live service/workload placement in the
 * inventory graph against the generated homelab rule set and emits one
 * `policy_drift` Observation per violation (issue #35, invariant #62).
 *
 * Dynamic-first design (invariant #62):
 * - The policy document is generated fresh from the live graph on every
 *   scan — topology changes (new GPU node, added worker) are automatically
 *   reflected without code changes.
 * - All rules are keyed on discovered attributes (role, capability tags, env)
 *   — never on hard-coded machine or service names.
 * - The probe degrades gracefully: if the graph is unreachable it returns [].
 *
 * Rules evaluated (derived from `policy-generator.ts`):
 *
 *   **Placement rules** — `rule.type === 'placement'` with `rule.when.capability`
 *     For every node tagged with `rule.when.capability`, any service co-located
 *     on that node constitutes a violation. This covers:
 *       - `no-workloads-on-manager` (capability: 'manager', effect: deny → P0)
 *       - `storage-array-protection` (capability: 'storage', effect: require-approval → P1)
 *
 *   **Affinity rules** — `rule.type === 'affinity'` with `params.antiAffinity.role`
 *     For every node, count co-located services whose role matches the
 *     anti-affinity role. When `maxPerNode` is present, count > maxPerNode is a
 *     violation. When absent, count > 1 is a violation. This covers:
 *       - `media-anti-affinity`    (anti-affinity role: 'media', effect: deny → P0)
 *       - `arr-stack-anti-affinity` (anti-affinity role: 'arr-stack', maxPerNode: 1, effect: deny → P0)
 *
 *   **GPU-placement rules** — `rule.type === 'placement'` with
 *     `params.require.capability === 'gpu'` and `rule.when.tag.value` (service role):
 *     Any service whose role matches `rule.when.tag.value` that is NOT running
 *     on a node tagged `gpu` violates this rule. Covers:
 *       - `gpu-required-for-media` (effect: deny → P0)
 *
 * Observations emitted per violation:
 *   - `pattern`:   `'policy_drift'`
 *   - `platform`:  caller-supplied `platformId`
 *   - `resource`:  `service/<service-name>@node/<node-name>`
 *   - `severity`:  `'P0'` when `effect === 'deny'`; `'P1'` when `effect === 'require-approval'`
 *   - `details`:   `{ rule_id, rule_type, expected, observed, node_id, service_id }`
 *   - `dedup_key`: `<platformId>:policy_drift:rule/<rule_id>/<serviceId>`
 *
 * Wiring: constructed and passed as `policyDriftProbe` in
 * `BuildLiveProbesOptions`; appended last in `buildLiveProbes`.
 */

import type { GraphStore } from '../../discovery/graph-store.js';
import type { Entity } from '../../discovery/graph-types.js';
import type { Observation, Severity } from '../types.js';
import { BaseProbe } from './base.js';
import { TopologyAnalyzer, inferCapabilityTags } from '../../rules/topology.js';
import { PolicyGenerator, type PolicyRule } from '../../rules/policy-generator.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for `PolicyDriftProbe`.
 */
export interface PolicyDriftProbeOptions {
  /**
   * Platform identifier used for dedup keys and observation metadata.
   * Typically the primary host's hostname or a synthetic sentinel such as
   * `'homelab'` when no host list is available.
   */
  platformId: string;

  /**
   * Graph store used to enumerate nodes, services, and edges.
   * The probe calls `all()` once per scan — no writes.
   */
  graphStore: GraphStore;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a policy rule's effect to an observation severity.
 *
 * @param effect - Rule effect string from the policy document.
 * @returns `'P0'` for `'deny'`, `'P1'` for `'require-approval'`, `'P2'` otherwise.
 */
function effectToSeverity(effect: string): Severity {
  if (effect === 'deny') return 'P0';
  if (effect === 'require-approval') return 'P1';
  return 'P2';
}

/**
 * Extract the string value of a nested record path, returning `''` when
 * the path is absent or the value is not a string.
 *
 * @param obj  - Object to traverse.
 * @param keys - Key path to walk.
 */
function getNestedString(obj: Record<string, unknown>, ...keys: string[]): string {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

// ---------------------------------------------------------------------------
// PolicyDriftProbe
// ---------------------------------------------------------------------------

/**
 * Probe that evaluates the live inventory graph against the generated homelab
 * policy rule set and emits `policy_drift` observations for every violation.
 *
 * Cadence: `slow` — policy rules are structural; checking every hour is
 * sufficient to catch post-failover misplacements before they cause harm.
 *
 * Graceful degradation: any graph-read or policy-generation error returns
 * `[]` rather than throwing (best-effort per the collector contract).
 */
export class PolicyDriftProbe extends BaseProbe {
  readonly id = 'policy-drift';
  readonly cadence = 'slow' as const;
  readonly platformId: string;

  private readonly graphStore: GraphStore;

  /**
   * @param opts - Construction options (platformId + graphStore).
   */
  constructor(opts: PolicyDriftProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.graphStore = opts.graphStore;
  }

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  /**
   * Enumerate all nodes and their co-located services; evaluate placement and
   * affinity rules; emit one `policy_drift` observation per violation.
   *
   * Returns `[]` when the graph is unreachable or the policy cannot be
   * generated (graceful degradation).
   */
  async scan(): Promise<Observation[]> {
    try {
      return await this.evaluate();
    } catch {
      // Best-effort: any error degrades to empty observation list.
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Private implementation
  // -------------------------------------------------------------------------

  /**
   * Core evaluation logic. Called by `scan()`; may throw (caller catches).
   *
   * Steps:
   *   1. Analyse the graph to derive topology facts.
   *   2. Generate the policy document from the topology.
   *   3. Load the full graph (entities + edges) to build a per-node service
   *      placement map.
   *   4. For each policy rule, evaluate the live placement against the rule
   *      and collect violations.
   *
   * @returns Array of `policy_drift` observations (may be empty).
   */
  private async evaluate(): Promise<Observation[]> {
    // Step 1 + 2: topology analysis + policy generation.
    const analyzer = new TopologyAnalyzer(this.graphStore);
    const topology = await analyzer.analyze();
    const policy = new PolicyGenerator().generate(topology);

    // Step 3: build a full placement map from the graph.
    const doc = await this.graphStore.all();
    const { entities, edges } = doc;

    // Index entities by id for fast lookup.
    const entityById = new Map<string, Entity>();
    for (const e of entities) {
      entityById.set(e.id, e);
    }

    // Build neighbor map (bidirectional).
    const neighborMap = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!neighborMap.has(edge.from)) neighborMap.set(edge.from, new Set());
      if (!neighborMap.has(edge.to)) neighborMap.set(edge.to, new Set());
      neighborMap.get(edge.from)!.add(edge.to);
      neighborMap.get(edge.to)!.add(edge.from);
    }

    // For each node/platform entity, collect:
    //   - its capability tags (from the topology analyzer logic)
    //   - its co-located services (neighbors with kind=service|container)
    const nodeKinds = new Set(['node', 'platform']);
    const serviceKinds = new Set(['service', 'container']);

    interface NodePlacement {
      entity: Entity;
      capabilityTags: string[];
      services: Entity[];
    }

    const nodePlacements: NodePlacement[] = [];

    for (const entity of entities) {
      if (!nodeKinds.has(entity.kind)) continue;

      const neighborIds = neighborMap.get(entity.id) ?? new Set<string>();
      const neighbors: Entity[] = [];
      for (const nid of neighborIds) {
        const n = entityById.get(nid);
        if (n !== undefined) neighbors.push(n);
      }

      const capabilityTags = inferCapabilityTags(entity, neighbors);
      const services = neighbors.filter((n) => serviceKinds.has(n.kind));

      nodePlacements.push({ entity, capabilityTags, services });
    }

    // Step 4: evaluate each rule against the placement map.
    const observations: Observation[] = [];

    for (const rule of policy.rules) {
      const ruleObs = this.evaluateRule(rule, nodePlacements);
      observations.push(...ruleObs);
    }

    return observations;
  }

  /**
   * Evaluate one policy rule against all node placements and return any
   * observations for violations found.
   *
   * @param rule           - Policy rule to evaluate.
   * @param nodePlacements - Per-node service placement information.
   * @returns Array of `policy_drift` observations for violations (may be empty).
   */
  private evaluateRule(
    rule: PolicyRule,
    nodePlacements: Array<{
      entity: Entity;
      capabilityTags: string[];
      services: Entity[];
    }>,
  ): Observation[] {
    const observations: Observation[] = [];

    if (rule.type === 'placement') {
      // --- Capability-based placement denial ---------------------------------
      // Rule: no workloads on nodes tagged with `when.capability`.
      // Violation: any service is co-located on such a node.
      const requiredCapability = getNestedString(
        rule.when as Record<string, unknown> ?? {},
        'capability',
      );
      if (requiredCapability !== '') {
        for (const { entity: node, capabilityTags, services } of nodePlacements) {
          if (!capabilityTags.includes(requiredCapability)) continue;
          for (const svc of services) {
            const obs = this.makeViolationObservation({
              rule,
              node,
              service: svc,
              expected: `no workloads on node with capability '${requiredCapability}'`,
              observed: `service '${svc.name}' is co-located on node '${node.name}' tagged '${requiredCapability}'`,
            });
            observations.push(obs);
          }
        }
        return observations;
      }

      // --- GPU-required-for-role placement -----------------------------------
      // Rule: services with role=<tag.value> must run on a node with
      //       `params.require.capability === 'gpu'`.
      // Violation: service with matching role NOT on a GPU node.
      const whenTagValue = getNestedString(
        rule.when as Record<string, unknown> ?? {},
        'tag', 'value',
      );
      const requireCapability = getNestedString(
        rule.params as Record<string, unknown>,
        'require', 'capability',
      );
      if (whenTagValue !== '' && requireCapability !== '') {
        for (const { entity: node, capabilityTags, services } of nodePlacements) {
          const nodeHasCapability = capabilityTags.includes(requireCapability);
          if (nodeHasCapability) continue; // node satisfies the requirement

          for (const svc of services) {
            const svcRole = typeof svc.attributes['role'] === 'string'
              ? svc.attributes['role']
              : '';
            if (svcRole !== whenTagValue) continue;

            const obs = this.makeViolationObservation({
              rule,
              node,
              service: svc,
              expected: `service with role '${whenTagValue}' must run on a node with '${requireCapability}' capability`,
              observed: `service '${svc.name}' (role='${svcRole}') is running on node '${node.name}' which lacks the '${requireCapability}' capability`,
            });
            observations.push(obs);
          }
        }
        return observations;
      }
    }

    if (rule.type === 'affinity') {
      // --- Anti-affinity rule -----------------------------------------------
      // Rule: at most `params.maxPerNode` (default 1) services with the
      //       given anti-affinity role may run on the same node.
      // Violation: count > maxPerNode.
      const antiAffinityRole = getNestedString(
        rule.params as Record<string, unknown>,
        'antiAffinity', 'role',
      );
      if (antiAffinityRole === '') return observations;

      const rawMax = (rule.params as Record<string, unknown>)['maxPerNode'];
      const maxPerNode = typeof rawMax === 'number' ? rawMax : 1;

      for (const { entity: node, services } of nodePlacements) {
        const matchingServices = services.filter((svc) => {
          const svcRole = typeof svc.attributes['role'] === 'string'
            ? svc.attributes['role']
            : '';
          return svcRole === antiAffinityRole;
        });

        if (matchingServices.length <= maxPerNode) continue;

        // Emit one observation per excess service (all services after the first
        // `maxPerNode` are considered violators — deterministic ordering by id).
        const sorted = [...matchingServices].sort((a, b) => a.id.localeCompare(b.id));
        const violators = sorted.slice(maxPerNode);

        for (const svc of violators) {
          const obs = this.makeViolationObservation({
            rule,
            node,
            service: svc,
            expected: `at most ${maxPerNode} service(s) with role '${antiAffinityRole}' per node`,
            observed: `${matchingServices.length} service(s) with role '${antiAffinityRole}' are co-located on node '${node.name}'`,
          });
          observations.push(obs);
        }
      }
    }

    return observations;
  }

  /**
   * Build a `policy_drift` Observation for a single violation.
   *
   * @param opts.rule     - The violated policy rule.
   * @param opts.node     - The node where the violation occurs.
   * @param opts.service  - The offending service entity.
   * @param opts.expected - Human-readable description of the expected state.
   * @param opts.observed - Human-readable description of the actual state.
   * @returns A fully-formed `policy_drift` Observation.
   */
  private makeViolationObservation(opts: {
    rule: PolicyRule;
    node: Entity;
    service: Entity;
    expected: string;
    observed: string;
  }): Observation {
    const { rule, node, service, expected, observed } = opts;
    const resource = `service/${service.name}@node/${node.name}`;
    const severity = effectToSeverity(rule.effect);

    // Override the dedup_key to be stable per (rule, service) pair — not per
    // (platform, pattern, resource) — so the same violation on the same service
    // deduplicates across sweeps even if the node name changes (e.g. after a
    // live-migration).
    const dedupKey = `${this.platformId}:policy_drift:rule/${rule.id}/${service.id}`;

    const obs = this.makeObservation({
      platform: this.platformId,
      pattern: 'policy_drift',
      resource,
      severity,
      details: {
        rule_id: rule.id,
        rule_type: rule.type,
        rule_effect: rule.effect,
        expected,
        observed,
        node_id: node.id,
        node_name: node.name,
        service_id: service.id,
        service_name: service.name,
      },
    });

    // Replace the auto-generated dedup_key with the stable one.
    return { ...obs, dedup_key: dedupKey };
  }
}
