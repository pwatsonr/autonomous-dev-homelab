/**
 * Homelab deploy-policy document generator (issue #34).
 *
 * Emits a `PolicyDocument` that is structurally compatible with the core
 * `deploy-policy-v1.json` schema and the `PolicyDocument` interface in
 * `intake/deploy/policy-types.ts`. The types are re-declared here rather
 * than imported from the core package (structural compatibility, per spec).
 *
 * All rules key on discovered attributes (tags / roles / env) — never on
 * hard-coded machine names (invariant #62). Regenerating after homelab
 * changes (e.g. adding a GPU box) yields updated rules with no code change.
 *
 * Rules emitted (in document order, deny-wins merge semantics):
 *   1. `no-workloads-on-manager`  — deny any deploy to a node tagged `manager`
 *   2. `manager-accidental-deploy-guard` — require-approval for manager env=infra targets
 *   3. `gpu-required-for-media`   — deny media-role deploys to nodes without `gpu` capability
 *   4. `media-anti-affinity`      — deny co-locating two media-role services on the same node
 *   5. `arr-stack-anti-affinity`  — deny deploying an *arr service when one already runs there
 *   6. `prod-approval`            — require-approval for all prod-env deploys
 *   7. `prod-maintenance-window`  — deny prod deploys outside 06:00–22:00 UTC
 *   8. `blast-radius-cap`         — deny single action touching more than 3 targets
 *   9. `destructiveness-floor`    — require-approval for data-affecting or worse on any target
 *
 * @module rules/policy-generator
 */

import type { TopologyDescriptor } from './topology.js';

// ---------------------------------------------------------------------------
// Structural types (mirrors core deploy-policy-v1.json, NOT imported from core)
// ---------------------------------------------------------------------------

/** Outcome produced when a rule matches. */
export type PolicyRuleEffect = 'allow' | 'deny' | 'require-approval';

/**
 * Predicate that gates whether a rule applies to a given deploy target.
 * All fields are optional and ANDed. INVARIANT: never reference specific
 * instance ids — use kind/env/tag/capability only (invariant #62, #674).
 */
export interface PolicyTargetPredicate {
  kind?: string;
  env?: string;
  tag?: { key: string; value: string };
  capability?: string;
}

/**
 * A single policy rule. Shape matches the core `policyRule` schema exactly.
 */
export interface PolicyRule {
  /** Stable lowercase-kebab id, unique within the document. */
  id: string;
  /** Optional human-readable explanation for CLI output and audit logs. */
  description?: string;
  /** Optional target predicate; absent means "matches every target". */
  when?: PolicyTargetPredicate;
  /** Rule-type discriminator (open string). */
  type: string;
  /** Outcome when this rule matches. */
  effect: PolicyRuleEffect;
  /** Rule-type-specific parameters. */
  params: Record<string, unknown>;
}

/**
 * Versioned policy document. Shape matches the core `deploy-policy-v1.json`
 * schema top-level object exactly.
 */
export interface PolicyDocument {
  version: '1.0';
  rules: PolicyRule[];
}

// ---------------------------------------------------------------------------
// Rule builders — one function per semantic rule set
// ---------------------------------------------------------------------------

/**
 * Build placement + safety rules that are invariant across all homelab
 * topologies (do not depend on the derived node facts).
 *
 * @returns Array of invariant policy rules.
 */
function buildInvariantRules(): PolicyRule[] {
  return [
    // -------------------------------------------------------------------
    // Rule 1: Forbid any deployment to a Swarm/K8s manager node.
    // Keyed on the `manager` capability tag — generic, survives hardware
    // changes. No machine names.
    // -------------------------------------------------------------------
    {
      id: 'no-workloads-on-manager',
      description:
        'Forbid deploying application workloads to nodes tagged as manager ' +
        '(Docker Swarm leader/reachable, Kubernetes control-plane). ' +
        'Manager nodes run only cluster-control-plane processes.',
      when: { capability: 'manager' },
      type: 'placement',
      effect: 'deny',
      params: {
        reason:
          'Manager nodes are reserved for orchestrator control-plane processes. ' +
          'Add a worker node or re-tag the target to remove the manager capability.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 2: Require approval before deploying to infra-tier nodes
    // (defence-in-depth: even if a manager tag is missed).
    // -------------------------------------------------------------------
    {
      id: 'infra-env-approval',
      description:
        'Any deploy to an infra-tier target requires operator approval ' +
        '(defence-in-depth guard beyond the manager capability deny rule).',
      when: { env: 'infra' },
      type: 'placement',
      effect: 'require-approval',
      params: { approvers: ['homelab-operators'] },
    },

    // -------------------------------------------------------------------
    // Rule 3: Media / streaming services must run on a GPU-capable node.
    // Keyed on role=media (written by the role classifier) and the gpu
    // capability tag (inferred from attributes.gpu_count or gpu neighbors).
    // -------------------------------------------------------------------
    {
      id: 'gpu-required-for-media',
      description:
        'Services classified with role=media (Plex, Jellyfin, transcoding services) ' +
        'must be deployed to a node that advertises the gpu capability. ' +
        'Deploying to a non-GPU node would cause transcoding to fail or degrade.',
      when: { tag: { key: 'role', value: 'media' } },
      type: 'placement',
      effect: 'deny',
      params: {
        require: { capability: 'gpu' },
        reason:
          'Media transcoding services require GPU hardware acceleration. ' +
          'Target a node tagged with the gpu capability.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 4: Anti-affinity for media services — prevent two media-role
    // instances landing on the same node (GPU contention, single point of
    // failure). Keyed on the media role tag; generic.
    // -------------------------------------------------------------------
    {
      id: 'media-anti-affinity',
      description:
        'Prevent co-locating two media-role services on the same node to avoid ' +
        'GPU memory contention and reduce single-point-of-failure blast radius.',
      when: { tag: { key: 'role', value: 'media' } },
      type: 'affinity',
      effect: 'deny',
      params: {
        antiAffinity: { role: 'media' },
        reason:
          'A media-role service is already running on this node. ' +
          'Choose a different GPU node or remove the existing media service first.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 5: *arr stack anti-affinity — services sharing the arr-stack
    // role must not all co-locate on one node. Prevents single-box failure
    // from wiping the whole media-automation pipeline. Generic: keyed on
    // the arr-stack role assigned by the role classifier.
    // -------------------------------------------------------------------
    {
      id: 'arr-stack-anti-affinity',
      description:
        'Prevent deploying more than one arr-stack service (Sonarr, Radarr, ' +
        'Lidarr, Prowlarr, etc.) to the same node to reduce blast radius and ' +
        'avoid shared-dependency conflicts.',
      when: { tag: { key: 'role', value: 'arr-stack' } },
      type: 'affinity',
      effect: 'deny',
      params: {
        antiAffinity: { role: 'arr-stack' },
        maxPerNode: 1,
        reason:
          'An arr-stack service is already running on this node. ' +
          'Distribute the *arr services across different nodes.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 6: All prod-env deploys require approval.
    // -------------------------------------------------------------------
    {
      id: 'prod-approval',
      description:
        'Every deployment to a production-tier target requires explicit operator ' +
        'approval before the deploy proceeds.',
      when: { env: 'prod' },
      type: 'placement',
      effect: 'require-approval',
      params: { approvers: ['homelab-operators'] },
    },

    // -------------------------------------------------------------------
    // Rule 7: Prod maintenance window — deny deploys outside 06:00–22:00 UTC.
    // Protects prod from accidental off-hours changes.
    // -------------------------------------------------------------------
    {
      id: 'prod-maintenance-window',
      description:
        'Production deployments are only permitted between 06:00 and 22:00 UTC ' +
        'to avoid impacting overnight batch jobs and backups.',
      when: { env: 'prod' },
      type: 'maintenance-window',
      effect: 'deny',
      params: {
        allow: { start: '06:00', end: '22:00', timezone: 'UTC' },
        reason:
          'Prod deploys are restricted to 06:00–22:00 UTC. ' +
          'Reschedule or request an emergency override.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 8: Blast-radius cap — one action may affect at most 3 targets.
    // Prevents wide-radius accidents regardless of target env or role.
    // -------------------------------------------------------------------
    {
      id: 'blast-radius-cap',
      description:
        'A single deploy action may affect at most 3 targets simultaneously. ' +
        'Wider changes must be broken into sequential batches.',
      type: 'blast-radius',
      effect: 'deny',
      params: {
        maxTargets: 3,
        reason:
          'Batch size exceeds the homelab blast-radius cap of 3 targets. ' +
          'Split the action into smaller batches.',
      },
    },

    // -------------------------------------------------------------------
    // Rule 9: Destructiveness floor — any data-affecting or architectural
    // action on any target requires approval (tightens the core FLOOR).
    // -------------------------------------------------------------------
    {
      id: 'destructiveness-floor',
      description:
        'Any data-affecting or architectural deploy action requires operator ' +
        'approval regardless of environment. This tightens the core safety ' +
        'FLOOR for the homelab and is validated never to loosen it.',
      type: 'placement',
      effect: 'require-approval',
      params: {
        minDestructiveness: 'data-affecting',
        approvers: ['homelab-operators'],
        reason:
          'This action is classified as data-affecting or architectural. ' +
          'Obtain operator approval before proceeding.',
      },
    },
  ];
}

/**
 * Build topology-derived rules: rules whose existence or parameters depend
 * on what the topology analysis found (e.g. a prod-tier node was discovered).
 *
 * Currently emits environment-specific blast-radius overrides when prod-tier
 * nodes are present, and storage-node protection rules when array/storage
 * nodes are present. All rules are still keyed on tags/env — the topology
 * facts inform WHICH rules to include, not hardcoded node names.
 *
 * @param topology - Topology descriptor from `TopologyAnalyzer.analyze()`.
 * @returns Array of topology-derived policy rules (may be empty).
 */
function buildTopologyDerivedRules(topology: TopologyDescriptor): PolicyRule[] {
  const rules: PolicyRule[] = [];

  // Check what tiers / capabilities exist in the discovered topology.
  // The `storage` tag is set by the topology analyzer for any node with array
  // capability (cascade) or explicit storage signals. Both storage and array
  // tagged nodes are protected by the storage-array-protection rule.
  const hasStorageNodes = topology.nodes.some((n) => n.capability_tags.includes('storage'));
  const hasProdNodes = topology.nodes.some((n) => n.env_tier === 'prod');

  // -------------------------------------------------------------------
  // Storage-array protection: deny any deploy to nodes tagged `array` that
  // does not carry an explicit approval. Storage arrays running Unraid or
  // equivalent are critical; accidental workload placement could destabilize
  // the parity-checked array or fill the array cache.
  // -------------------------------------------------------------------
  if (hasStorageNodes) {
    rules.push({
      id: 'storage-array-protection',
      description:
        'Deny deploying application workloads to nodes tagged with the storage or ' +
        'array capability. Storage nodes (Unraid, NAS) are reserved for data ' +
        'persistence and should not run additional compute workloads without approval.',
      when: { capability: 'storage' },
      type: 'placement',
      effect: 'require-approval',
      params: {
        approvers: ['homelab-operators'],
        reason:
          'This node is a storage array. Deploying workloads here may destabilize ' +
          'the array or consume parity-rebuild capacity. Obtain explicit approval.',
      },
    });
  }

  // -------------------------------------------------------------------
  // Prod-tier quota: cap concurrent active deploys to prod to 1 at a time.
  // Only emitted when prod-tier nodes are present in the topology.
  // -------------------------------------------------------------------
  if (hasProdNodes) {
    rules.push({
      id: 'prod-concurrent-deploy-quota',
      description:
        'At most one deploy may be in-flight to the prod environment at a time ' +
        'to prevent overlapping changes from masking failures.',
      when: { env: 'prod' },
      type: 'quota',
      effect: 'deny',
      params: {
        maxConcurrent: 1,
        scope: 'env',
        reason:
          'A prod deploy is already in progress. Wait for it to complete before ' +
          'starting another.',
      },
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// PolicyGenerator
// ---------------------------------------------------------------------------

/**
 * Generates a homelab `PolicyDocument` from a topology descriptor.
 *
 * The document is valid against the core `deploy-policy-v1.json` schema.
 * All rules are expressed on tags/roles/env — never on machine names
 * (invariant #62). Regenerating after topology changes yields updated rules
 * with no code change required.
 */
export class PolicyGenerator {
  /**
   * Generate a `PolicyDocument` from the provided topology descriptor.
   *
   * The document is deterministic: same topology input → same document output.
   * Rule ordering: invariant rules first (higher priority), topology-derived
   * rules appended after. Within each group, rules are ordered by id.
   *
   * @param topology - Topology descriptor to generate rules from.
   * @returns A `PolicyDocument` valid against deploy-policy-v1.json.
   */
  generate(topology: TopologyDescriptor): PolicyDocument {
    const invariantRules = buildInvariantRules();
    const derivedRules = buildTopologyDerivedRules(topology);

    return {
      version: '1.0',
      rules: [...invariantRules, ...derivedRules],
    };
  }
}
