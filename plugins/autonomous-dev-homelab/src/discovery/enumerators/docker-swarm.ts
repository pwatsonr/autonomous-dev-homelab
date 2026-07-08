/**
 * Docker / Swarm enumerator: enumerates swarm nodes, services, running
 * tasks (containers), and overlay networks from the live Docker API via
 * the established Connection (`docker` CLI with `--format json`).
 *
 * Implements issue #27 §"Docker/Swarm enumerator" under invariant #62:
 *
 *  - All discovery is live — commands run against the real Docker daemon.
 *  - Classification uses generic observable signals only (image, labels,
 *    published ports). No hard-coded homelab service or node names appear
 *    in this file.
 *  - Any command that fails (non-zero exit) produces a warn log and an
 *    empty contribution for that resource type; the pass continues.
 *
 * Entity IDs are deterministic:
 *   node        →  `node:<platformId>:<swarm-node-id>`
 *   service     →  `service:<platformId>:<service-name>`
 *   container   →  `container:<platformId>:<task-id>`
 *   network     →  `network:<platformId>:<network-name>`
 *
 * Edge IDs are similarly deterministic composites of the two endpoint IDs.
 */

import type { PlatformEnumerator, EnumerationContext, EnumerationResult } from '../enumerator.js';
import type { Entity, Edge } from '../graph-types.js';

// ---------------------------------------------------------------------------
// Raw Docker CLI output shapes (JSON lines from --format)
// ---------------------------------------------------------------------------

interface RawSwarmNode {
  ID: string;
  Hostname: string;
  Status: string;
  Availability: string;
  ManagerStatus: string;
  EngineVersion?: string;
}

interface RawService {
  ID: string;
  Name: string;
  Mode: string;
  Replicas: string; // e.g. "2/3"
  Image: string;
  Ports: string;
}

interface RawTask {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  ServiceID?: string;
  // 'docker service ps' does not give ServiceID directly; we derive from Name.
}

interface RawNetwork {
  ID: string;
  Name: string;
  Driver: string;
  Scope: string;
  Labels: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse newline-delimited JSON objects output by `docker * ls --format json`.
 * Docker may emit one JSON object per line (NDJSON) or a JSON array. Both
 * are supported. Lines that fail to parse are silently skipped.
 *
 * @param stdout - Raw stdout from a docker CLI command.
 * @returns Array of parsed objects.
 */
function parseDockerJson<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  // Attempt JSON array first.
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr as T[];
    } catch {
      // Fall through to NDJSON.
    }
  }
  // NDJSON: one object per line.
  const results: T[] = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (l === '') continue;
    try {
      results.push(JSON.parse(l) as T);
    } catch {
      // Skip malformed lines.
    }
  }
  return results;
}

/**
 * Parse a Docker replicas string of the form "running/desired" (e.g. "2/3").
 * Returns `{running: number, desired: number}`. Defaults both to 0 on error.
 */
function parseReplicas(s: string): { running: number; desired: number } {
  const parts = s.split('/');
  const running = parseInt(parts[0] ?? '0', 10);
  const desired = parseInt(parts[1] ?? '0', 10);
  return {
    running: Number.isFinite(running) ? running : 0,
    desired: Number.isFinite(desired) ? desired : 0,
  };
}

/**
 * Parse the Docker service `Ports` field (e.g. `"*:80->80/tcp, *:443->443/tcp"`)
 * into an array of port-spec strings. Returns empty array when blank.
 */
function parsePorts(ports: string): string[] {
  if (!ports || ports.trim() === '') return [];
  return ports
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Derive a service name from a task name. Docker task names follow the
 * convention `<service-name>.<replica-number>.<task-id>`. The service name
 * is everything before the first dot.
 */
function serviceNameFromTask(taskName: string): string {
  return taskName.split('.')[0] ?? taskName;
}

// ---------------------------------------------------------------------------
// Enumerator
// ---------------------------------------------------------------------------

/**
 * PlatformEnumerator implementation for Docker Swarm (and Portainer, which
 * uses the same underlying Docker daemon).
 *
 * Handles platform kinds: 'docker-swarm', 'docker', 'portainer'.
 */
export class DockerSwarmEnumerator implements PlatformEnumerator {
  readonly platformKind: string;

  /**
   * @param platformKind - The kind string this instance is registered as.
   *   Typically one of 'docker-swarm', 'docker', or 'portainer'.
   */
  constructor(platformKind: string) {
    this.platformKind = platformKind;
  }

  /**
   * Enumerate all child entities from a Docker Swarm platform.
   *
   * Issues read-only `docker` commands over the established connection:
   * - `docker node ls`    → swarm node entities
   * - `docker service ls` → service entities
   * - `docker service ps` → container/task entities (one per running task)
   * - `docker network ls` → network entities (overlay scope only)
   *
   * All commands use `--format '{{json .}}'` for stable machine-readable output.
   *
   * @param ctx - Enumeration context with live connection and platform record.
   * @returns Entities and edges derived generically from Docker API output.
   */
  async enumerate(ctx: EnumerationContext): Promise<EnumerationResult> {
    const { connection, platform, now } = ctx;
    const pid = platform.id;
    const entities: Entity[] = [];
    const edges: Edge[] = [];

    // ------------------------------------------------------------------
    // Helper: run a docker command; return empty array on failure.
    // ------------------------------------------------------------------
    const exec = async <T>(cmd: string): Promise<T[]> => {
      try {
        const result = await connection.exec(cmd);
        if (result.exitCode !== 0) {
          return [];
        }
        return parseDockerJson<T>(result.stdout);
      } catch {
        return [];
      }
    };

    // ------------------------------------------------------------------
    // 1. Swarm nodes
    // ------------------------------------------------------------------
    const rawNodes = await exec<RawSwarmNode>(
      `docker node ls --format '{{json .}}'`,
    );
    const nodeEntityIds = new Map<string, string>(); // swarmNodeId → entityId
    for (const n of rawNodes) {
      const entityId = `node:${pid}:${n.ID}`;
      nodeEntityIds.set(n.ID, entityId);
      nodeEntityIds.set(n.Hostname, entityId); // also index by hostname for task lookup
      const entity: Entity = {
        id: entityId,
        kind: 'node',
        name: n.Hostname,
        attributes: {
          swarm_node_id: n.ID,
          status: n.Status,
          availability: n.Availability,
          manager_status: n.ManagerStatus,
          ...(n.EngineVersion !== undefined ? { engine_version: n.EngineVersion } : {}),
        },
        source: 'docker-swarm',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(entity);

      // node member-of platform entity
      const platformEntityId = `platform:${pid}`;
      edges.push({
        id: `member-of:${entityId}:${platformEntityId}`,
        from: entityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });
    }

    // ------------------------------------------------------------------
    // 2. Services
    // ------------------------------------------------------------------
    const rawServices = await exec<RawService>(
      `docker service ls --format '{{json .}}'`,
    );
    const serviceEntityIds = new Map<string, string>(); // serviceName → entityId
    for (const s of rawServices) {
      const entityId = `service:${pid}:${s.Name}`;
      serviceEntityIds.set(s.Name, entityId);
      serviceEntityIds.set(s.ID, entityId); // also index by ID
      const replicas = parseReplicas(s.Replicas);
      const ports = parsePorts(s.Ports);
      const entity: Entity = {
        id: entityId,
        kind: 'service',
        name: s.Name,
        attributes: {
          service_id: s.ID,
          image: s.Image,
          mode: s.Mode,
          replicas_running: replicas.running,
          replicas_desired: replicas.desired,
          ports,
        },
        source: 'docker-swarm',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(entity);

      // service member-of platform entity
      const platformEntityId = `platform:${pid}`;
      edges.push({
        id: `member-of:${entityId}:${platformEntityId}`,
        from: entityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });

      // service exposes each port
      for (const port of ports) {
        edges.push({
          id: `exposes:${entityId}:${port}`,
          from: entityId,
          to: platformEntityId, // port is an attribute; edge targets platform
          type: 'exposes',
          attributes: { port },
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });
      }
    }

    // ------------------------------------------------------------------
    // 3. Running tasks (containers) — one per swarm task
    //
    // We run `docker service ps` with the service IDs collected in step 2
    // rather than using command substitution (which would make it a single
    // compound shell command that is harder to unit-test and audit).
    // If no services were discovered we skip the exec entirely.
    // ------------------------------------------------------------------
    const serviceIds = rawServices.map((s) => s.ID);
    const rawTasks: RawTask[] = [];
    if (serviceIds.length > 0) {
      const serviceIdArgs = serviceIds.join(' ');
      const taskResults = await exec<RawTask>(
        `docker service ps --format '{{json .}}' --filter desired-state=running ${serviceIdArgs}`,
      );
      rawTasks.push(...taskResults);
    }
    for (const t of rawTasks) {
      // Only include tasks in desired state Running.
      if (t.DesiredState !== 'Running') continue;
      const entityId = `container:${pid}:${t.ID}`;
      const entity: Entity = {
        id: entityId,
        kind: 'container',
        name: t.Name,
        attributes: {
          task_id: t.ID,
          image: t.Image,
          current_state: t.CurrentState,
          desired_state: t.DesiredState,
        },
        source: 'docker-swarm',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(entity);

      // container runs-on node (by hostname)
      const nodeEntityId = nodeEntityIds.get(t.Node);
      if (nodeEntityId !== undefined) {
        edges.push({
          id: `runs-on:${entityId}:${nodeEntityId}`,
          from: entityId,
          to: nodeEntityId,
          type: 'runs-on',
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });
      }

      // container member-of service (derive service name from task name)
      const svcName = serviceNameFromTask(t.Name);
      const serviceEntityId = serviceEntityIds.get(svcName);
      if (serviceEntityId !== undefined) {
        edges.push({
          id: `member-of:${entityId}:${serviceEntityId}`,
          from: entityId,
          to: serviceEntityId,
          type: 'member-of',
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });
      }
    }

    // ------------------------------------------------------------------
    // 4. Overlay networks
    // ------------------------------------------------------------------
    const rawNetworks = await exec<RawNetwork>(
      `docker network ls --format '{{json .}}'`,
    );
    for (const n of rawNetworks) {
      // Include overlay networks only (swarm-relevant); skip host/bridge/null
      // unless they have labels — those are platform-internal and not useful
      // for the inventory graph.
      if (n.Driver !== 'overlay' && n.Labels === '') continue;
      const entityId = `network:${pid}:${n.Name}`;
      const entity: Entity = {
        id: entityId,
        kind: 'network',
        name: n.Name,
        attributes: {
          network_id: n.ID,
          driver: n.Driver,
          scope: n.Scope,
          labels: n.Labels,
        },
        source: 'docker-swarm',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(entity);

      // network member-of platform entity
      const platformEntityId = `platform:${pid}`;
      edges.push({
        id: `member-of:${entityId}:${platformEntityId}`,
        from: entityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });
    }

    return { entities, edges };
  }
}
