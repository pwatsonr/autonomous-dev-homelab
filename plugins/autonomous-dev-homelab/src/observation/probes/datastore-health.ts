/**
 * Datastore health/replication/capacity probes (issue #43).
 *
 * Emits Observations for:
 *   - `datastore_unhealthy`      (P0) — liveness probe failure
 *   - `replication_lag`          (P1) — replica lag or replication absent
 *   - `datastore_near_capacity`  (P1) — connection saturation / memory pressure
 *   - `datastore_disk_pressure`  (P0) — disk usage approaching limit
 *
 * Design (dynamic-first invariant, issue #62):
 * - Per-engine signal logic lives in small `EngineHealthProbe` objects
 *   registered in a local registry. New engines plug in via
 *   `registerHealthProbe`; the orchestrator `DatastoreHealthProbe`
 *   dispatches generically.
 * - All probes are READ-ONLY. No command reads user row/key/document
 *   values. Structural health metadata only (connection counts, lag
 *   seconds, memory bytes, disk bytes).
 * - Unreachable datastore degrades safely: returns a single
 *   `datastore_unhealthy` (P0) observation; never throws.
 * - No hard-coded instance names, credentials, or host lists.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';
import type { Entity } from '../../discovery/graph-types.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import { imageContains } from '../../discovery/datastore-probe.js';

// ---------------------------------------------------------------------------
// Exec source (narrow interface for testability)
// ---------------------------------------------------------------------------

/**
 * Exec source accepted by every engine health probe.
 * Matches the subset of `Connection` that probes actually use.
 */
export interface DatastoreHealthExecSource {
  readonly platformId: string;
  exec(command: string): Promise<{ stdout: string; exitCode?: number }>;
}

// ---------------------------------------------------------------------------
// Per-engine health probe interface
// ---------------------------------------------------------------------------

/**
 * A generic health signal set returned by each engine health probe.
 * All fields are optional — engines report what they can measure.
 */
export interface EngineHealthSignals {
  /** True when the datastore responds to a liveness check. */
  alive: boolean;
  /** Number of active connections (-1 = unavailable). */
  connections: number;
  /** Configured maximum connections (-1 = unavailable or unlimited). */
  max_connections: number;
  /** Replication role ('primary' | 'replica' | 'standalone' | 'unknown'). */
  replication_role: string;
  /** Replication lag in seconds (-1 = not applicable or unavailable). */
  replication_lag_seconds: number;
  /** Data directory disk usage in bytes (-1 = unavailable). */
  disk_used_bytes: number;
  /** Data directory disk limit in bytes (-1 = unavailable). */
  disk_limit_bytes: number;
  /** Memory used by the datastore process in bytes (-1 = unavailable). */
  memory_used_bytes: number;
  /** Memory limit for the datastore in bytes (-1 = unavailable). */
  memory_limit_bytes: number;
}

/** Default empty/unavailable signals — engines override what they know. */
const DEFAULT_SIGNALS: EngineHealthSignals = {
  alive: false,
  connections: -1,
  max_connections: -1,
  replication_role: 'unknown',
  replication_lag_seconds: -1,
  disk_used_bytes: -1,
  disk_limit_bytes: -1,
  memory_used_bytes: -1,
  memory_limit_bytes: -1,
};

/**
 * Interface for per-engine health probes.
 *
 * Invariant #62: `matches` uses generic image signals only.
 * `collectSignals` issues READ-ONLY commands that never access user data.
 */
export interface EngineHealthProbe {
  /** Open-string engine identifier. */
  readonly engine: string;

  /**
   * Returns true when this probe handles the given datastore entity.
   * Uses generic image-name signals (no instance names).
   */
  matches(entity: Entity): boolean;

  /**
   * Collect read-only health signals from the container via `exec`.
   * Must NEVER read user row/key/document values.
   * Returns `{ alive: false, ...defaults }` on any error.
   *
   * @param entity - The datastore entity being probed.
   * @param exec   - Exec source (docker exec delegator).
   */
  collectSignals(
    entity: Entity,
    exec: DatastoreHealthExecSource,
  ): Promise<EngineHealthSignals>;
}

// ---------------------------------------------------------------------------
// Health probe registry
// ---------------------------------------------------------------------------

const HEALTH_PROBE_REGISTRY = new Map<string, EngineHealthProbe>();

/**
 * Register an EngineHealthProbe for its `engine` key.
 * Later registrations override earlier ones (enables test mocking).
 */
export function registerHealthProbe(probe: EngineHealthProbe): void {
  HEALTH_PROBE_REGISTRY.set(probe.engine, probe);
}

/** Returns all registered health probe engine strings. */
export function registeredHealthEngines(): string[] {
  return Array.from(HEALTH_PROBE_REGISTRY.keys());
}

/**
 * Find the first registered health probe whose `matches()` fires for entity.
 */
export function findHealthProbe(entity: Entity): EngineHealthProbe | undefined {
  for (const probe of HEALTH_PROBE_REGISTRY.values()) {
    if (probe.matches(entity)) return probe;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Docker exec helper (safe; zero on non-zero exit)
// ---------------------------------------------------------------------------

async function safeDockerExec(
  exec: DatastoreHealthExecSource,
  containerName: string,
  command: string,
): Promise<string> {
  try {
    const result = await exec.exec(`docker exec ${containerName} ${command}`);
    if ((result.exitCode ?? 0) !== 0) return '';
    return result.stdout;
  } catch {
    return '';
  }
}

/** Extract container name from entity attributes or name field. */
function entityContainerName(entity: Entity): string {
  const cn = entity.attributes['container_name'];
  if (typeof cn === 'string' && cn !== '') return cn;
  const sn = entity.attributes['source_entity_id'];
  if (typeof sn === 'string' && sn !== '') {
    // source_entity_id format: "service:<pid>:<name>" or "container:<pid>:<name>"
    const parts = sn.split(':');
    if (parts.length >= 3) return parts.slice(2).join(':');
  }
  return entity.name;
}

// ---------------------------------------------------------------------------
// Built-in per-engine health probes
// ---------------------------------------------------------------------------

const postgresHealthProbe: EngineHealthProbe = {
  engine: 'postgres',

  matches(entity: Entity): boolean {
    const engine = entity.attributes['engine'];
    if (typeof engine === 'string' && engine === 'postgres') return true;
    return imageContains(entity, 'postgres', 'postgresql', 'timescaledb', 'pgvector');
  },

  async collectSignals(entity: Entity, exec: DatastoreHealthExecSource): Promise<EngineHealthSignals> {
    const cname = entityContainerName(entity);

    // Liveness (no user data)
    const pingOut = await safeDockerExec(exec, cname, `psql -U postgres -t -A -c 'SELECT 1'`);
    const alive = pingOut.trim() === '1';

    if (!alive) return { ...DEFAULT_SIGNALS, alive: false };

    // Connection stats (pg_stat_activity is a system view — no user data)
    const connOut = await safeDockerExec(
      exec,
      cname,
      `psql -U postgres -t -A -c "SELECT count(*) FROM pg_stat_activity"`,
    );
    const connections = parseInt(connOut.trim(), 10);

    const maxConnOut = await safeDockerExec(
      exec,
      cname,
      `psql -U postgres -t -A -c 'SHOW max_connections'`,
    );
    const max_connections = parseInt(maxConnOut.trim(), 10);

    // Replication role
    const replOut = await safeDockerExec(
      exec,
      cname,
      `psql -U postgres -t -A -c 'SELECT pg_is_in_recovery()'`,
    );
    const isReplica = replOut.trim() === 't';
    const replication_role = isReplica ? 'replica' : 'primary';

    // Replication lag (replica only — no user data)
    let replication_lag_seconds = -1;
    if (isReplica) {
      const lagOut = await safeDockerExec(
        exec,
        cname,
        `psql -U postgres -t -A -c "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int"`,
      );
      const lag = parseInt(lagOut.trim(), 10);
      if (Number.isFinite(lag) && lag >= 0) replication_lag_seconds = lag;
    }

    // Disk: pg_database_size aggregate (structure-only, no user data)
    const diskOut = await safeDockerExec(
      exec,
      cname,
      `psql -U postgres -t -A -c "SELECT sum(pg_database_size(datname)) FROM pg_database"`,
    );
    const disk_used_bytes = parseInt(diskOut.trim(), 10);

    return {
      alive,
      connections: Number.isFinite(connections) ? connections : -1,
      max_connections: Number.isFinite(max_connections) ? max_connections : -1,
      replication_role,
      replication_lag_seconds,
      disk_used_bytes: Number.isFinite(disk_used_bytes) ? disk_used_bytes : -1,
      disk_limit_bytes: -1,
      memory_used_bytes: -1,
      memory_limit_bytes: -1,
    };
  },
};

const redisHealthProbe: EngineHealthProbe = {
  engine: 'redis',

  matches(entity: Entity): boolean {
    const engine = entity.attributes['engine'];
    if (typeof engine === 'string' && engine === 'redis') return true;
    return imageContains(entity, 'redis', 'valkey', 'dragonfly', 'keydb');
  },

  async collectSignals(entity: Entity, exec: DatastoreHealthExecSource): Promise<EngineHealthSignals> {
    const cname = entityContainerName(entity);

    // Liveness
    const pingOut = await safeDockerExec(exec, cname, `redis-cli PING`);
    const alive = pingOut.trim() === 'PONG';
    if (!alive) return { ...DEFAULT_SIGNALS, alive: false };

    // INFO all (read-only server stats — no key values)
    const infoOut = await safeDockerExec(exec, cname, `redis-cli INFO all`);

    const parseField = (pattern: RegExp): number => {
      const m = pattern.exec(infoOut);
      if (!m) return -1;
      const val = parseFloat(m[1] ?? '-1');
      return Number.isFinite(val) ? val : -1;
    };

    const connections = parseField(/connected_clients:(\d+)/);
    const max_connections = parseField(/maxclients:(\d+)/);
    const memory_used_bytes = parseField(/used_memory:(\d+)/);
    const memory_limit_bytes = parseField(/maxmemory:(\d+)/);

    const roleMatch = /role:(\w+)/.exec(infoOut);
    const rawRole = roleMatch ? (roleMatch[1] ?? 'standalone') : 'standalone';
    // Normalize Redis 'slave' (legacy term) to 'replica' for uniform signal processing.
    const replication_role = rawRole === 'slave' ? 'replica' : rawRole;

    let replication_lag_seconds = -1;
    const lagMatch = /master_last_io_seconds_ago:(\d+)/.exec(infoOut);
    if (lagMatch) {
      const lag = parseInt(lagMatch[1] ?? '-1', 10);
      if (Number.isFinite(lag) && lag >= 0) replication_lag_seconds = lag;
    }

    return {
      alive,
      connections,
      max_connections,
      replication_role,
      replication_lag_seconds,
      disk_used_bytes: -1,
      disk_limit_bytes: -1,
      memory_used_bytes,
      // maxmemory of 0 means unlimited
      memory_limit_bytes: memory_limit_bytes > 0 ? memory_limit_bytes : -1,
    };
  },
};

const opensearchHealthProbe: EngineHealthProbe = {
  engine: 'opensearch',

  matches(entity: Entity): boolean {
    const engine = entity.attributes['engine'];
    if (typeof engine === 'string' && engine === 'opensearch') return true;
    return imageContains(entity, 'opensearch', 'elasticsearch');
  },

  async collectSignals(entity: Entity, exec: DatastoreHealthExecSource): Promise<EngineHealthSignals> {
    const cname = entityContainerName(entity);

    // Cluster health (read-only — no document access)
    const healthOut = await safeDockerExec(
      exec,
      cname,
      `curl -s localhost:9200/_cluster/health`,
    );
    if (healthOut === '') return { ...DEFAULT_SIGNALS, alive: false };

    let clusterStatus = 'unknown';
    let unassigned_shards = 0;
    try {
      const j = JSON.parse(healthOut) as Record<string, unknown>;
      if (typeof j['status'] === 'string') clusterStatus = j['status'];
      if (typeof j['unassigned_shards'] === 'number') {
        unassigned_shards = j['unassigned_shards'] as number;
      }
    } catch {
      return { ...DEFAULT_SIGNALS, alive: false };
    }
    void unassigned_shards; // acknowledged — available for future use in details

    // Red cluster is treated as unavailable (data loss risk); yellow/green → alive.
    const alive = clusterStatus === 'green' || clusterStatus === 'yellow';

    // Node stats for disk (read-only system API)
    const nodesOut = await safeDockerExec(
      exec,
      cname,
      `curl -s 'localhost:9200/_nodes/stats/fs'`,
    );
    let disk_used_bytes = -1;
    let disk_limit_bytes = -1;
    try {
      const nodesJson = JSON.parse(nodesOut) as Record<string, unknown>;
      const nodes = nodesJson['nodes'] as Record<string, unknown> | undefined;
      if (nodes !== undefined) {
        let totalUsed = 0;
        let totalLimit = 0;
        for (const node of Object.values(nodes)) {
          const fsTotal = (node as Record<string, unknown>)['fs'] as Record<string, unknown> | undefined;
          const fsData = fsTotal?.['total'] as Record<string, unknown> | undefined;
          const used = typeof fsData?.['available_in_bytes'] === 'number'
            ? (fsData['total_in_bytes'] as number ?? 0) - (fsData['available_in_bytes'] as number)
            : 0;
          const limit = typeof fsData?.['total_in_bytes'] === 'number'
            ? (fsData['total_in_bytes'] as number)
            : 0;
          totalUsed += used;
          totalLimit += limit;
        }
        if (totalLimit > 0) { disk_used_bytes = totalUsed; disk_limit_bytes = totalLimit; }
      }
    } catch {
      // leave disk as -1
    }

    return {
      alive,
      connections: -1, // OpenSearch doesn't expose this simply
      max_connections: -1,
      replication_role: 'standalone', // cluster mode — no simple primary/replica
      replication_lag_seconds: -1,
      disk_used_bytes,
      disk_limit_bytes,
      memory_used_bytes: -1,
      memory_limit_bytes: -1,
    };
  },
};

const neo4jHealthProbe: EngineHealthProbe = {
  engine: 'neo4j',

  matches(entity: Entity): boolean {
    const engine = entity.attributes['engine'];
    if (typeof engine === 'string' && engine === 'neo4j') return true;
    return imageContains(entity, 'neo4j');
  },

  async collectSignals(entity: Entity, exec: DatastoreHealthExecSource): Promise<EngineHealthSignals> {
    const cname = entityContainerName(entity);

    // Health via HTTP status endpoint (no graph data returned)
    const statusOut = await safeDockerExec(
      exec,
      cname,
      `curl -s http://localhost:7474/db/neo4j/cluster/available`,
    );

    // 200 OK → available; anything else → down
    const alive = statusOut.trim() !== '';

    if (!alive) return { ...DEFAULT_SIGNALS, alive: false };

    return {
      alive,
      connections: -1,
      max_connections: -1,
      replication_role: 'standalone',
      replication_lag_seconds: -1,
      disk_used_bytes: -1,
      disk_limit_bytes: -1,
      memory_used_bytes: -1,
      memory_limit_bytes: -1,
    };
  },
};

// Register built-in health probes
registerHealthProbe(postgresHealthProbe);
registerHealthProbe(redisHealthProbe);
registerHealthProbe(opensearchHealthProbe);
registerHealthProbe(neo4jHealthProbe);

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Fraction of max_connections that triggers `datastore_near_capacity`. */
const CONNECTION_SATURATION_THRESHOLD = 0.85;

/** Fraction of memory_limit_bytes that triggers `datastore_near_capacity` for Redis. */
const MEMORY_SATURATION_THRESHOLD = 0.85;

/** Fraction of disk_limit_bytes that triggers `datastore_disk_pressure`. */
const DISK_PRESSURE_THRESHOLD = 0.85;

/** Replication lag in seconds above which `replication_lag` is emitted. */
const REPLICATION_LAG_THRESHOLD_SECONDS = 30;

// ---------------------------------------------------------------------------
// DatastoreHealthProbe
// ---------------------------------------------------------------------------

/**
 * Orchestrates health checks across all `kind='datastore'` entities in the
 * graph store, dispatching to the appropriate per-engine health probe.
 *
 * Emits Observations for:
 *   - `datastore_unhealthy`     — datastore is down or unreachable
 *   - `replication_lag`         — replica lag above threshold
 *   - `datastore_near_capacity` — connection or memory saturation
 *   - `datastore_disk_pressure` — disk usage above threshold
 *
 * Dedup key: `<platformId>:<pattern>:<resourcePath>`
 *
 * The probe NEVER reads user row/key/document values. All exec commands
 * target read-only system/status APIs.
 */
export class DatastoreHealthProbe extends BaseProbe {
  readonly id = 'datastore-health';
  readonly cadence = 'medium' as const;

  private readonly graphStore: GraphStore;
  private readonly execSource: DatastoreHealthExecSource;

  /**
   * @param platformId - The platform this probe targets.
   * @param graphStore - Graph store for reading datastore entities.
   * @param execSource - Exec source backed by the platform connection.
   */
  constructor(
    readonly platformId: string,
    graphStore: GraphStore,
    execSource: DatastoreHealthExecSource,
  ) {
    super();
    this.graphStore = graphStore;
    this.execSource = execSource;
  }

  /**
   * Scan all `kind='datastore'` entities in the graph and emit health
   * observations. Gracefully degrades: a failing exec returns a single
   * `datastore_unhealthy` observation per entity rather than crashing.
   */
  async scan(): Promise<Observation[]> {
    let datastoreEntities: Entity[];
    try {
      datastoreEntities = await this.graphStore.entitiesByKind('datastore');
    } catch (err) {
      return [this.unreachable(err, 'datastore-health', `graph/${this.platformId}`)];
    }

    const observations: Observation[] = [];

    for (const entity of datastoreEntities) {
      const entityObs = await this.probeEntity(entity);
      observations.push(...entityObs);
    }

    return observations;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Probe a single datastore entity and return any observations. */
  private async probeEntity(entity: Entity): Promise<Observation[]> {
    const engineProbe = findHealthProbe(entity);
    if (engineProbe === undefined) {
      // No registered health probe for this engine — skip silently
      return [];
    }

    let signals: EngineHealthSignals;
    try {
      signals = await engineProbe.collectSignals(entity, this.execSource);
    } catch {
      // Treat unexpected errors as unreachable
      signals = { ...DEFAULT_SIGNALS, alive: false };
    }

    const resource = `datastore/${entity.name}`;
    const observations: Observation[] = [];

    // 1. Liveness
    if (!signals.alive) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'datastore_unhealthy',
          resource,
          severity: 'P0',
          details: {
            engine: entity.attributes['engine'] ?? 'unknown',
            entity_id: entity.id,
          },
        }),
      );
      // If the datastore is down, skip subsequent signal checks
      return observations;
    }

    // 2. Replication lag
    if (
      signals.replication_role === 'replica' &&
      signals.replication_lag_seconds >= 0 &&
      signals.replication_lag_seconds > REPLICATION_LAG_THRESHOLD_SECONDS
    ) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'replication_lag',
          resource,
          severity: 'P1',
          details: {
            engine: entity.attributes['engine'] ?? 'unknown',
            lag_seconds: signals.replication_lag_seconds,
            threshold_seconds: REPLICATION_LAG_THRESHOLD_SECONDS,
          },
        }),
      );
    }

    // 3. Connection saturation (where applicable)
    if (
      signals.connections >= 0 &&
      signals.max_connections > 0 &&
      signals.connections / signals.max_connections >= CONNECTION_SATURATION_THRESHOLD
    ) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'datastore_near_capacity',
          resource,
          severity: 'P1',
          details: {
            engine: entity.attributes['engine'] ?? 'unknown',
            connections: signals.connections,
            max_connections: signals.max_connections,
            saturation: Math.round((signals.connections / signals.max_connections) * 100),
          },
        }),
      );
    }

    // 4. Memory saturation (Redis maxmemory check)
    if (
      signals.memory_used_bytes >= 0 &&
      signals.memory_limit_bytes > 0 &&
      signals.memory_used_bytes / signals.memory_limit_bytes >= MEMORY_SATURATION_THRESHOLD
    ) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'datastore_near_capacity',
          resource,
          severity: 'P1',
          details: {
            engine: entity.attributes['engine'] ?? 'unknown',
            memory_used_bytes: signals.memory_used_bytes,
            memory_limit_bytes: signals.memory_limit_bytes,
            saturation: Math.round(
              (signals.memory_used_bytes / signals.memory_limit_bytes) * 100,
            ),
          },
        }),
      );
    }

    // 5. Disk pressure
    if (
      signals.disk_used_bytes >= 0 &&
      signals.disk_limit_bytes > 0 &&
      signals.disk_used_bytes / signals.disk_limit_bytes >= DISK_PRESSURE_THRESHOLD
    ) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'datastore_disk_pressure',
          resource,
          severity: 'P0',
          details: {
            engine: entity.attributes['engine'] ?? 'unknown',
            disk_used_bytes: signals.disk_used_bytes,
            disk_limit_bytes: signals.disk_limit_bytes,
            saturation: Math.round(
              (signals.disk_used_bytes / signals.disk_limit_bytes) * 100,
            ),
          },
        }),
      );
    }

    return observations;
  }
}
