/**
 * Entity + edge types for the inventory graph (version 2).
 *
 * Design principles (dynamic-first invariant, issue #62):
 * - `kind` and edge `type` are open strings, NOT enums. New kinds and
 *   edge types can appear in the graph without any schema change or code
 *   change to the store.
 * - `KNOWN_KINDS` is a documentation/helper registry only; the store
 *   never validates against it.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle status of any graph element. */
export type GraphStatus = 'active' | 'stale' | 'gone';

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/**
 * A discovered or declared entity in the inventory graph.
 *
 * `kind` is an open string — the store accepts any value. See {@link KNOWN_KINDS}
 * for the set of well-known kinds that get typed helpers, but callers are free
 * to introduce new kinds without touching this file.
 */
export interface Entity {
  /** Stable unique identifier within the graph. */
  id: string;
  /**
   * Open-string classification. Well-known values are listed in
   * {@link KNOWN_KINDS}. Unknown values MUST be accepted by the store.
   */
  kind: string;
  /** Human-readable display name. */
  name: string;
  /** Arbitrary key-value attributes discovered from the source platform. */
  attributes: Record<string, unknown>;
  /** Origin of the discovery (e.g. "inventory-manager", "portainer", "k8s"). */
  source: string;
  /** Parent platform id when this entity belongs to a specific platform. */
  platformId?: string;
  /** ISO-8601 UTC timestamp when this entity was first discovered. */
  discovered_at: string;
  /** ISO-8601 UTC timestamp of the last successful observation. */
  last_seen: string;
  /** Lifecycle status. */
  status: GraphStatus;
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

/**
 * A directed relationship between two entities.
 *
 * `type` is an open string. Well-known values are listed in
 * {@link KNOWN_EDGE_TYPES}. Unknown types MUST be accepted by the store.
 */
export interface Edge {
  /** Stable unique identifier within the graph. */
  id: string;
  /** Entity id of the source endpoint. */
  from: string;
  /** Entity id of the target endpoint. */
  to: string;
  /**
   * Open-string relationship type. Well-known values are listed in
   * {@link KNOWN_EDGE_TYPES}.
   */
  type: string;
  /** Optional additional metadata about this relationship. */
  attributes?: Record<string, unknown>;
  /** ISO-8601 UTC timestamp when this edge was first discovered. */
  discovered_at: string;
  /** ISO-8601 UTC timestamp of the last successful observation. */
  last_seen: string;
  /** Lifecycle status. */
  status: GraphStatus;
}

// ---------------------------------------------------------------------------
// Graph document (persisted to inventory-graph.yaml)
// ---------------------------------------------------------------------------

/** Shape of the versioned YAML document written to disk. */
export interface GraphDocument {
  version: 2;
  entities: Entity[];
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Known-kinds registry (documentation only — not enforced by the store)
// ---------------------------------------------------------------------------

/**
 * Well-known entity kinds. This object documents the set of kinds that ship
 * with the control plane. The store accepts any string as `kind`; this
 * registry exists only so TypeScript callers can use named constants rather
 * than magic strings.
 *
 * Adding a new kind to this registry DOES NOT require a schema change.
 * Callers may use kinds not listed here; the store persists them as-is.
 */
export const KNOWN_KINDS = {
  /** Physical or virtual compute node. */
  node: 'node',
  /** Discovered management platform (Proxmox, Unraid, Docker, …). */
  platform: 'platform',
  /** A running service or application. */
  service: 'service',
  /** A container instance. */
  container: 'container',
  /** A database or other data store. */
  datastore: 'datastore',
  /** An ingress/reverse-proxy route. */
  route: 'route',
  /** A reference to a secret (NOT the secret value). */
  'secret-ref': 'secret-ref',
  /** A storage volume. */
  'storage-volume': 'storage-volume',
  /** A network segment or VLAN. */
  network: 'network',
  /** A Model Context Protocol server. */
  'mcp-server': 'mcp-server',
  /** A scheduled or one-shot job. */
  job: 'job',
} as const satisfies Record<string, string>;

/**
 * Well-known edge relationship types. Documentation only; the store accepts
 * any string as edge `type`.
 */
export const KNOWN_EDGE_TYPES = {
  /** Entity runs on a node. */
  'runs-on': 'runs-on',
  /** Node/platform hosts an entity. */
  hosts: 'hosts',
  /** Entity depends on another entity. */
  'depends-on': 'depends-on',
  /** Traffic routes to a target entity. */
  'routes-to': 'routes-to',
  /** One entity backs up another. */
  'backs-up': 'backs-up',
  /** Entity exposes a port/interface to another. */
  exposes: 'exposes',
  /** Entity is a member of a group/network/cluster. */
  'member-of': 'member-of',
} as const satisfies Record<string, string>;
