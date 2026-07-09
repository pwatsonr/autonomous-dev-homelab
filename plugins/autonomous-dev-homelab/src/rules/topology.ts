/**
 * Topology fact derivation for the homelab rules system (issue #34).
 *
 * Derives per-node facts from the inventory graph generically:
 * for each node/platform entity, its `role`, `env_tier`, and
 * `capability_tags` (gpu / array / storage / manager / worker) are
 * inferred from entity attributes and from the services/GPU/array
 * entities that are connected to it via edges.
 *
 * Dynamic-first invariant (#62): no host names or service instance
 * names are hard-coded here. Classification is entirely driven by
 * observable attributes (`attributes.role`, `attributes.gpu_count`,
 * `attributes.manager_status`, `attributes.kind`, etc.) that the
 * discovery enumerators populate.
 *
 * @module rules/topology
 */

import type { GraphStore } from '../discovery/graph-store.js';
import type { Entity } from '../discovery/graph-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Capability tags a node may carry. Open strings — new capabilities can be
 * added without changing the policy generator (invariant #62).
 *
 * Well-known values:
 *   `gpu`      — node has at least one GPU (NVIDIA, AMD, or otherwise)
 *   `array`    — node is a storage array host (Unraid md array)
 *   `storage`  — node has large attached or local storage (shares / volumes)
 *   `manager`  — node is a Docker Swarm or Kubernetes control-plane manager
 *   `worker`   — node is a plain compute worker (not a manager)
 */
export type CapabilityTag = string;

/**
 * Environment tier derived for a node. Open string.
 *
 * Well-known values:
 *   `prod`     — node carries production workloads
 *   `staging`  — pre-production environment
 *   `dev`      — development / experimental
 *   `infra`    — infrastructure-only node (manager, etc.)
 *   `unknown`  — could not be inferred
 */
export type EnvTier = string;

/**
 * The role of a node. Open string; mirrors the role attribute written by
 * the role classifier for service entities, adapted to infrastructure nodes.
 *
 * Well-known values:
 *   `storage`    — primary storage host (Unraid, TrueNAS, etc.)
 *   `compute`    — general-purpose compute node
 *   `manager`    — orchestrator control-plane node
 *   `hypervisor` — virtual-machine host (Proxmox, ESXi)
 *   `unknown`    — could not be determined
 */
export type NodeRole = string;

/**
 * Derived topology facts for a single node or platform entity.
 *
 * Never carries a hard-coded machine name — `id` and `name` come from the
 * graph entity as discovered, and the consuming policy generator keys its
 * rules on `role`, `env_tier`, and `capability_tags` only.
 */
export interface NodeFacts {
  /** Graph entity id. */
  id: string;
  /** Human-readable name from the graph entity. */
  name: string;
  /** Entity kind (`node`, `platform`, …). */
  kind: string;
  /**
   * Role of the node derived from entity attributes and attached entities.
   * See {@link NodeRole} for well-known values.
   */
  role: NodeRole;
  /**
   * Logical environment tier derived from entity attributes.
   * See {@link EnvTier} for well-known values.
   */
  env_tier: EnvTier;
  /**
   * Set of capability tags for this node.
   * See {@link CapabilityTag} for well-known values.
   */
  capability_tags: CapabilityTag[];
  /**
   * Roles of the service entities attached to this node
   * (via `runs-on` or `hosts` edges). Used by the policy generator
   * to produce placement and anti-affinity rules generically.
   */
  hosted_service_roles: string[];
}

/**
 * The full topology descriptor — all node facts derived from the graph.
 *
 * Serialised to JSON by `rules show --json` and written by `rules export`.
 * The consuming policy generator reads this; both live in this module so
 * no network I/O is required.
 */
export interface TopologyDescriptor {
  /** ISO-8601 UTC timestamp when the descriptor was generated. */
  generated_at: string;
  /** Per-node facts, ordered by entity id. */
  nodes: NodeFacts[];
}

// ---------------------------------------------------------------------------
// Capability-tag inference helpers (data-driven, no instance names)
// ---------------------------------------------------------------------------

/**
 * Infer capability tags for a single entity from its own attributes and from
 * the kinds/roles of its neighbors. Pure function — no I/O.
 *
 * Tag derivation rules (all generic, keyed on observable attributes):
 *   `gpu`     → entity has `attributes.gpu_count > 0` OR a neighbor with
 *               kind=`gpu` is connected via any edge.
 *   `array`   → entity has `attributes.array_state` (Unraid md array) OR a
 *               neighbor with kind=`storage-array` exists.
 *   `storage` → entity has kind=`storage-array`/`share`/`storage-volume`,
 *               OR `attributes.role` contains `storage`, OR a neighbor with
 *               kind=`share` or `storage-volume` exists.
 *   `manager` → `attributes.manager_status` is `Leader` / `Reachable` /
 *               `manager`, OR `attributes.role` is `manager` or
 *               `control-plane`, OR `attributes.node_role` is `master` /
 *               `control-plane`.
 *   `worker`  → entity is a compute node AND `manager` tag is NOT set.
 *
 * @param entity    - The entity being inspected.
 * @param neighbors - Entities directly connected to this entity via any edge.
 * @returns Array of capability tag strings (no duplicates, sorted).
 */
export function inferCapabilityTags(entity: Entity, neighbors: Entity[]): CapabilityTag[] {
  const tags = new Set<CapabilityTag>();
  const attrs = entity.attributes;

  // ---------- gpu ----------
  const gpuCount = attrs['gpu_count'];
  const hasGpuCount =
    (typeof gpuCount === 'number' && gpuCount > 0) ||
    (typeof gpuCount === 'string' && parseInt(gpuCount, 10) > 0);
  const hasGpuNeighbor = neighbors.some((n) => n.kind === 'gpu');
  if (hasGpuCount || hasGpuNeighbor) {
    tags.add('gpu');
  }

  // ---------- array ----------
  const arrayState = attrs['array_state'];
  const hasArrayAttr = typeof arrayState === 'string' && arrayState.trim() !== '';
  const hasArrayNeighbor = neighbors.some((n) => n.kind === 'storage-array');
  if (hasArrayAttr || hasArrayNeighbor) {
    tags.add('array');
  }

  // ---------- storage ----------
  const storageKinds = new Set(['storage-array', 'share', 'storage-volume']);
  const isStorageKind = storageKinds.has(entity.kind);
  const roleAttr = typeof attrs['role'] === 'string' ? (attrs['role'] as string) : '';
  const hasStorageRole = roleAttr.includes('storage');
  const hasShareNeighbor = neighbors.some(
    (n) => n.kind === 'share' || n.kind === 'storage-volume',
  );
  // A node with the `array` tag is also a storage node (the array IS the storage).
  if (isStorageKind || hasStorageRole || hasShareNeighbor || tags.has('array')) {
    tags.add('storage');
  }

  // ---------- manager ----------
  const managerStatus = typeof attrs['manager_status'] === 'string'
    ? (attrs['manager_status'] as string).toLowerCase()
    : '';
  const nodeRole = typeof attrs['node_role'] === 'string'
    ? (attrs['node_role'] as string).toLowerCase()
    : '';
  const platformType = typeof attrs['platform_type'] === 'string'
    ? (attrs['platform_type'] as string).toLowerCase()
    : '';
  const isManager =
    managerStatus === 'leader' ||
    managerStatus === 'reachable' ||
    managerStatus === 'manager' ||
    roleAttr === 'manager' ||
    roleAttr === 'control-plane' ||
    nodeRole === 'master' ||
    nodeRole === 'control-plane' ||
    platformType === 'proxmox'; // Proxmox nodes are infra/hypervisor managers
  if (isManager) {
    tags.add('manager');
  }

  // ---------- worker ----------
  // A node is a worker if it is a compute node and NOT a manager.
  const isComputeNode = entity.kind === 'node' || entity.kind === 'platform';
  if (isComputeNode && !tags.has('manager')) {
    tags.add('worker');
  }

  return Array.from(tags).sort();
}

/**
 * Derive the logical environment tier for an entity.
 *
 * Detection priority (highest first):
 *   1. `attributes.env` / `attributes.env_tier` / `attributes.environment` — explicit.
 *   2. `manager` tag already inferred → `infra`.
 *   3. `array` tag already inferred → `prod` (storage arrays are production).
 *   4. Default: `unknown`.
 *
 * @param entity - Graph entity.
 * @param tags   - Capability tags already inferred for this entity.
 * @returns Environment tier string.
 */
export function inferEnvTier(entity: Entity, tags: CapabilityTag[]): EnvTier {
  const attrs = entity.attributes;
  for (const key of ['env', 'env_tier', 'environment'] as const) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim() !== '') {
      return v.trim().toLowerCase();
    }
  }
  if (tags.includes('manager')) return 'infra';
  if (tags.includes('array')) return 'prod';
  return 'unknown';
}

/**
 * Derive the node role from entity attributes and inferred tags.
 *
 * @param entity - Graph entity.
 * @param tags   - Capability tags already inferred for this entity.
 * @returns Node role string.
 */
export function inferNodeRole(entity: Entity, tags: CapabilityTag[]): NodeRole {
  const attrs = entity.attributes;
  const explicitRole = typeof attrs['role'] === 'string' ? (attrs['role'] as string) : '';
  if (explicitRole !== '') return explicitRole;

  const platformType = typeof attrs['platform_type'] === 'string'
    ? (attrs['platform_type'] as string).toLowerCase()
    : '';
  if (platformType === 'proxmox') return 'hypervisor';
  if (platformType === 'unraid') return 'storage';

  if (tags.includes('manager')) return 'manager';
  if (tags.includes('array')) return 'storage';
  return 'compute';
}

// ---------------------------------------------------------------------------
// TopologyAnalyzer
// ---------------------------------------------------------------------------

/**
 * Derives a {@link TopologyDescriptor} from the live inventory graph.
 *
 * Invariant #62 compliance: reads from the generic graph API; no host or
 * service names are referenced. Capability tags are keyed on observable
 * entity attributes and graph-neighbor kinds only.
 */
export class TopologyAnalyzer {
  private readonly graphStore: GraphStore;
  private readonly clock: () => string;

  /**
   * @param graphStore - Inventory graph store to read from (read-only).
   * @param opts.clock - Optional clock override (returns ISO-8601). Defaults
   *                     to `new Date().toISOString()`. Injected by tests.
   */
  constructor(
    graphStore: GraphStore,
    opts: { clock?: () => string } = {},
  ) {
    this.graphStore = graphStore;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Derive topology facts from all `node` and `platform` entities in the graph.
   *
   * For each node/platform entity:
   *   1. Fetch direct graph neighbors (via all edge types).
   *   2. Infer capability tags from entity attributes + neighbor kinds.
   *   3. Infer env tier and role.
   *   4. Collect roles of connected service entities (for placement rules).
   *
   * @returns Fully populated topology descriptor.
   */
  async analyze(): Promise<TopologyDescriptor> {
    const doc = await this.graphStore.all();
    const { entities, edges } = doc;

    // Build a neighbor-lookup map: entityId → Set of neighbor entity ids.
    const neighborMap = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!neighborMap.has(edge.from)) neighborMap.set(edge.from, new Set());
      if (!neighborMap.has(edge.to)) neighborMap.set(edge.to, new Set());
      neighborMap.get(edge.from)!.add(edge.to);
      neighborMap.get(edge.to)!.add(edge.from);
    }

    // Index all entities by id for fast neighbor resolution.
    const entityById = new Map<string, Entity>();
    for (const e of entities) {
      entityById.set(e.id, e);
    }

    // Target kinds: nodes and platforms are the anchors for placement rules.
    const targetKinds = new Set(['node', 'platform']);
    const targetEntities = entities.filter((e) => targetKinds.has(e.kind));

    const nodes: NodeFacts[] = [];

    for (const entity of targetEntities) {
      const neighborIds = neighborMap.get(entity.id) ?? new Set<string>();
      const neighbors: Entity[] = [];
      for (const nid of neighborIds) {
        const n = entityById.get(nid);
        if (n !== undefined) neighbors.push(n);
      }

      const tags = inferCapabilityTags(entity, neighbors);
      const env_tier = inferEnvTier(entity, tags);
      const role = inferNodeRole(entity, tags);

      // Collect roles of directly-connected service entities so that the
      // policy generator can build generic placement and anti-affinity rules.
      const hostedServiceRoles = new Set<string>();
      for (const neighbor of neighbors) {
        if (neighbor.kind === 'service' || neighbor.kind === 'container') {
          const svcRole = neighbor.attributes['role'];
          if (typeof svcRole === 'string' && svcRole.trim() !== '') {
            hostedServiceRoles.add(svcRole.trim());
          }
        }
      }

      nodes.push({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        role,
        env_tier,
        capability_tags: tags,
        hosted_service_roles: Array.from(hostedServiceRoles).sort(),
      });
    }

    // Sort by id for deterministic output.
    nodes.sort((a, b) => a.id.localeCompare(b.id));

    return {
      generated_at: this.clock(),
      nodes,
    };
  }
}
