/**
 * Bridge: project an existing `Platform` (inventory v1) into graph entities.
 *
 * This is a lightweight adapter so that the current discovery path
 * (InventoryManager → Platform) can populate the graph store without
 * requiring a full re-enumeration cycle (that lives in issues #27 / #31).
 *
 * `platformToEntities` returns two entities:
 *   1. kind="platform" — the management API endpoint itself.
 *   2. kind="node"     — the underlying host machine.
 * and one edge:
 *   type="runs-on"    — from platform entity to node entity.
 *
 * Nothing in this file is specific to *this* homelab's topology; all values
 * derive from the Platform record (dynamic-first invariant, issue #62).
 */

import type { Platform } from './inventory-types.js';
import type { Entity, Edge } from './graph-types.js';

export interface PlatformProjection {
  entities: [Entity, Entity];
  edges: [Edge];
}

/**
 * Project a `Platform` record into a pair of graph entities and a connecting
 * edge, ready to be fed into {@link GraphStore.upsertEntity} /
 * {@link GraphStore.upsertEdge}.
 *
 * @param platform - The Platform to project.
 * @returns An object containing the `entities` array and `edges` array.
 *
 * IDs are deterministic:
 *   - platform entity id = `platform:<platform.id>`
 *   - node entity id     = `node:<platform.host>`
 *   - edge id            = `runs-on:<platform.id>`
 */
export function platformToEntities(platform: Platform): PlatformProjection {
  const platformEntityId = `platform:${platform.id}`;
  const nodeEntityId = `node:${platform.host}`;

  const platformEntity: Entity = {
    id: platformEntityId,
    kind: 'platform',
    name: platform.id,
    attributes: {
      type: platform.type,
      host: platform.host,
      port: platform.port,
      ...(platform.ssh_host !== undefined ? { ssh_host: platform.ssh_host } : {}),
      ...(platform.ssh_port !== undefined ? { ssh_port: platform.ssh_port } : {}),
      ...(platform.metadata !== undefined ? { metadata: platform.metadata } : {}),
      ...(platform.connection !== undefined ? { connection: platform.connection } : {}),
    },
    source: 'inventory-manager',
    platformId: platform.id,
    discovered_at: platform.discovered_at,
    last_seen: platform.last_seen,
    status: 'active',
  };

  const nodeEntity: Entity = {
    id: nodeEntityId,
    kind: 'node',
    name: platform.host,
    attributes: {
      host: platform.host,
      ...(platform.ssh_host !== undefined ? { ssh_host: platform.ssh_host } : {}),
      ...(platform.ssh_port !== undefined ? { ssh_port: platform.ssh_port } : {}),
    },
    source: 'inventory-manager',
    discovered_at: platform.discovered_at,
    last_seen: platform.last_seen,
    status: 'active',
  };

  const edge: Edge = {
    id: `runs-on:${platform.id}`,
    from: platformEntityId,
    to: nodeEntityId,
    type: 'runs-on',
    discovered_at: platform.discovered_at,
    last_seen: platform.last_seen,
    status: 'active',
  };

  return { entities: [platformEntity, nodeEntity], edges: [edge] };
}
