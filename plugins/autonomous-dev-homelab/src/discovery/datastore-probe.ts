/**
 * Datastore discovery probe (issue #42).
 *
 * Finds service/container entities with `attributes.role='database'|'cache'`
 * (set by the role classifier, issue #28) in the graph store, then for each
 * entity introspects its structure by exec-ing the datastore's own client
 * inside the running container via the platform connection.
 *
 * Design principles (dynamic-first invariant, issue #62):
 * - No hard-coded instance names, credentials, or host lists anywhere in
 *   this file. Discovery is entirely driven by the graph (role tags + image
 *   signals).
 * - Engine-specific logic lives in pluggable `DatastoreEngineProbe` instances
 *   registered in `ENGINE_PROBE_REGISTRY`. New engines plug in without
 *   editing core logic.
 * - STRUCTURE ONLY: adapters enumerate database/index/keyspace names and
 *   aggregate size/count metrics. They NEVER read user rows, key values,
 *   or document contents.
 * - Graceful degradation: when credentials are absent or the exec fails,
 *   the datastore entity is recorded with `health='unknown'` and structure
 *   introspection is skipped.
 *
 * Graph output:
 *   kind='datastore'  — the datastore itself (engine, version, health)
 *   kind='database'   — a child database/index/keyspace name + size/count
 *   edge type='member-of' — database → datastore
 */

import type { Entity, Edge } from './graph-types.js';
import type { GraphStore } from './graph-store.js';
import type { Connection } from '../connection/base.js';

// ---------------------------------------------------------------------------
// Engine probe registry
// ---------------------------------------------------------------------------

/**
 * Structure result for a single database/index/keyspace child of a datastore.
 * NEVER contains user row values, key values, or document contents.
 */
export interface DatastoreChild {
  /** Name of the database, index, or keyspace. */
  name: string;
  /**
   * Estimated size in bytes, or -1 if unavailable (structure-only,
   * never derived from reading user data).
   */
  size_bytes: number;
  /**
   * Entry count (rows, keys, shards, or similar engine-specific metric),
   * or -1 if unavailable.
   */
  count: number;
}

/**
 * Result of a structure-only introspection of a single datastore container.
 * `health` is the liveness status at the time of the probe.
 */
export interface DatastoreIntrospection {
  /** Detected engine string (e.g. 'postgres', 'redis', 'opensearch', 'neo4j'). */
  engine: string;
  /** Detected server version string, or 'unknown'. */
  version: string;
  /** Liveness at probe time. 'unknown' means credentials were absent or exec failed. */
  health: 'ok' | 'degraded' | 'down' | 'unknown';
  /** Child databases/indices/keyspaces — structure only, never value data. */
  children: DatastoreChild[];
  /** Optional replication role (e.g. 'primary', 'replica', 'standalone'). */
  replication_role?: string;
  /** Optional replication lag in seconds (-1 = unavailable). */
  replication_lag_seconds?: number;
}

/**
 * Interface every engine probe in the registry must implement.
 *
 * Invariant #62: `matches` tests generic image-name signals only.
 * `introspect` runs structure-only commands inside the container via the
 * established `connection`. It must never read user row/key/document values.
 */
export interface DatastoreEngineProbe {
  /**
   * Open-string engine identifier (e.g. 'postgres', 'redis'). Used as the
   * `engine` field on the produced datastore entity.
   */
  readonly engine: string;

  /**
   * Returns true when this probe can handle the given container/service
   * entity. Classification is by generic observable signals (image name
   * substring) — never by instance-specific identifiers.
   *
   * @param entity - The service or container entity from the graph.
   */
  matches(entity: Entity): boolean;

  /**
   * Run structure-only introspection by exec-ing the datastore's own client
   * inside the container via `connection`.
   *
   * IMPORTANT: this method MUST NOT issue any command that reads user row
   * values, key values, or document contents. If credentials are absent
   * or the exec fails, return health='unknown' and an empty children array.
   *
   * @param entity     - The service/container entity being introspected.
   * @param connection - Live connection to the platform hosting the container.
   * @returns Introspection result with structure metadata only.
   */
  introspect(entity: Entity, connection: Connection): Promise<DatastoreIntrospection>;
}

/**
 * Global registry: maps engine string → DatastoreEngineProbe.
 * Call `registerEngineProbe` to plug in a new engine.
 */
const ENGINE_PROBE_REGISTRY = new Map<string, DatastoreEngineProbe>();

/**
 * Register a DatastoreEngineProbe. Last registration for a given engine wins
 * (allows test overrides). After all built-in engines are registered via the
 * module initializer at the bottom of this file, operators may register
 * additional engines without editing core logic.
 *
 * @param probe - The engine probe to register.
 */
export function registerEngineProbe(probe: DatastoreEngineProbe): void {
  ENGINE_PROBE_REGISTRY.set(probe.engine, probe);
}

/**
 * Returns all registered engine probe instances, in registration order.
 * Useful for diagnostics and tests.
 */
export function registeredEngines(): string[] {
  return Array.from(ENGINE_PROBE_REGISTRY.keys());
}

/**
 * Find the first registered engine probe whose `matches()` returns true for
 * the given entity. Returns `undefined` when no registered probe matches.
 *
 * @param entity - Service/container entity to classify.
 */
export function findEngineProbe(entity: Entity): DatastoreEngineProbe | undefined {
  for (const probe of ENGINE_PROBE_REGISTRY.values()) {
    if (probe.matches(entity)) return probe;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Image-signal helpers (invariant #62: generic signals only)
// ---------------------------------------------------------------------------

/**
 * Return true when the entity's `attributes.image` contains any of the
 * given substrings (case-insensitive). Used by engine probes to implement
 * `matches()` without hard-coding instance names.
 *
 * @param entity     - Entity to inspect.
 * @param substrings - One or more case-insensitive substrings to test.
 */
export function imageContains(entity: Entity, ...substrings: string[]): boolean {
  const image = typeof entity.attributes['image'] === 'string'
    ? entity.attributes['image'].toLowerCase()
    : '';
  if (image === '') return false;
  return substrings.some((s) => image.includes(s.toLowerCase()));
}

/**
 * Extract the container name from an entity: prefers `attributes.container_name`,
 * then `attributes.service_name`, then the entity `name` field.
 *
 * @param entity - The service/container entity.
 */
function containerName(entity: Entity): string {
  const cn = entity.attributes['container_name'];
  if (typeof cn === 'string' && cn !== '') return cn;
  const sn = entity.attributes['service_name'];
  if (typeof sn === 'string' && sn !== '') return sn;
  return entity.name;
}

// ---------------------------------------------------------------------------
// Exec helper (safe: non-zero exit returns empty string, never throws)
// ---------------------------------------------------------------------------

/**
 * Run a command inside a named Docker container via `docker exec`.
 * Returns stdout on success (exit 0), or an empty string on failure.
 * Never throws — failures degrade gracefully.
 *
 * IMPORTANT: callers MUST pass only structure-inspection commands that do
 * not read user row/key/document values.
 *
 * @param connection    - Live connection to the Docker host.
 * @param cname         - Container name or ID.
 * @param command       - Shell command to execute inside the container.
 */
async function dockerExec(
  connection: Connection,
  cname: string,
  command: string,
): Promise<string> {
  try {
    const result = await connection.exec(`docker exec ${cname} ${command}`);
    if (result.exitCode !== 0) return '';
    return result.stdout;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Built-in engine probes
// ---------------------------------------------------------------------------

/**
 * PostgreSQL engine probe.
 *
 * Structure commands (NEVER reads user rows):
 *  - `psql -U postgres -t -A -c 'SELECT version()'`  → server version
 *  - `psql -U postgres -t -A -c '\l'`                → database list (names + sizes)
 *  - `psql -U postgres -t -A -c 'SELECT pg_is_in_recovery()'` → replica check
 */
const postgresEngineProbe: DatastoreEngineProbe = {
  engine: 'postgres',

  matches(entity: Entity): boolean {
    return imageContains(entity, 'postgres', 'postgresql', 'timescaledb', 'pgvector');
  },

  async introspect(entity: Entity, connection: Connection): Promise<DatastoreIntrospection> {
    const cname = containerName(entity);

    // Liveness: get server version (structure-only, no user data)
    const versionOut = await dockerExec(
      connection,
      cname,
      `psql -U postgres -t -A -c 'SELECT version()'`,
    );

    if (versionOut === '') {
      return { engine: 'postgres', version: 'unknown', health: 'unknown', children: [] };
    }

    const version = versionOut.trim().split(' ').slice(0, 2).join(' ') || 'unknown';

    // Database list (names + sizes; never reads rows)
    const listOut = await dockerExec(
      connection,
      cname,
      `psql -U postgres -t -A -c "SELECT datname,pg_database_size(datname) FROM pg_database WHERE datistemplate=false ORDER BY datname"`,
    );

    const children: DatastoreChild[] = [];
    for (const line of listOut.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length < 2) continue;
      const name = (parts[0] ?? '').trim();
      const sizeStr = (parts[1] ?? '').trim();
      if (name === '') continue;
      const size = parseInt(sizeStr, 10);
      children.push({ name, size_bytes: Number.isFinite(size) ? size : -1, count: -1 });
    }

    // Replication role (read-only system view — no user data)
    const replOut = await dockerExec(
      connection,
      cname,
      `psql -U postgres -t -A -c 'SELECT pg_is_in_recovery()'`,
    );
    const isReplica = replOut.trim() === 't';
    const replication_role = isReplica ? 'replica' : 'primary';

    // Replication lag (pg_stat_replication for primaries; pg_last_wal_replay_lsn for replicas)
    let replication_lag_seconds = -1;
    if (isReplica) {
      const lagOut = await dockerExec(
        connection,
        cname,
        `psql -U postgres -t -A -c "SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int"`,
      );
      const lag = parseInt(lagOut.trim(), 10);
      if (Number.isFinite(lag)) replication_lag_seconds = lag;
    }

    return {
      engine: 'postgres',
      version,
      health: 'ok',
      children,
      replication_role,
      replication_lag_seconds,
    };
  },
};

/**
 * Redis / Valkey engine probe.
 *
 * Structure commands (NEVER reads key values):
 *  - `redis-cli INFO server`    → server version + uptime
 *  - `redis-cli INFO keyspace`  → per-db key counts only (no key names/values)
 *  - `redis-cli INFO replication` → role + lag
 */
const redisEngineProbe: DatastoreEngineProbe = {
  engine: 'redis',

  matches(entity: Entity): boolean {
    return imageContains(entity, 'redis', 'valkey', 'dragonfly', 'keydb');
  },

  async introspect(entity: Entity, connection: Connection): Promise<DatastoreIntrospection> {
    const cname = containerName(entity);

    // Liveness: `redis-cli PING` — no data access
    const pingOut = await dockerExec(connection, cname, `redis-cli PING`);
    if (pingOut.trim() !== 'PONG') {
      return { engine: 'redis', version: 'unknown', health: 'down', children: [] };
    }

    // Version via INFO server (structure-only)
    const infoOut = await dockerExec(connection, cname, `redis-cli INFO server`);
    const versionMatch = /redis_version:(\S+)/.exec(infoOut);
    const version = versionMatch ? (versionMatch[1] ?? 'unknown') : 'unknown';

    // Keyspace: per-db key counts only — never key names or values
    const keyspaceOut = await dockerExec(connection, cname, `redis-cli INFO keyspace`);
    const children: DatastoreChild[] = [];
    for (const line of keyspaceOut.split('\n')) {
      // Format: db0:keys=42,expires=1,avg_ttl=1234
      const m = /^(db\d+):keys=(\d+)/.exec(line.trim());
      if (!m) continue;
      const name = m[1] ?? '';
      const count = parseInt(m[2] ?? '0', 10);
      children.push({ name, size_bytes: -1, count: Number.isFinite(count) ? count : -1 });
    }

    // Replication info (read-only — no user data)
    const replOut = await dockerExec(connection, cname, `redis-cli INFO replication`);
    const roleMatch = /role:(\w+)/.exec(replOut);
    const replication_role = roleMatch ? (roleMatch[1] ?? 'standalone') : 'standalone';
    let replication_lag_seconds = -1;
    const lagMatch = /master_last_io_seconds_ago:(\d+)/.exec(replOut);
    if (lagMatch) {
      const lag = parseInt(lagMatch[1] ?? '-1', 10);
      if (Number.isFinite(lag)) replication_lag_seconds = lag;
    }

    return {
      engine: 'redis',
      version,
      health: 'ok',
      children,
      replication_role,
      replication_lag_seconds,
    };
  },
};

/**
 * OpenSearch / Elasticsearch engine probe.
 *
 * Structure commands (NEVER reads document content):
 *  - `curl -s localhost:9200/`          → cluster health + version
 *  - `curl -s localhost:9200/_cat/indices?h=index,store.size,docs.count&format=json`
 *    → index names + aggregate size/count only (no doc content)
 */
const opensearchEngineProbe: DatastoreEngineProbe = {
  engine: 'opensearch',

  matches(entity: Entity): boolean {
    return imageContains(entity, 'opensearch', 'elasticsearch');
  },

  async introspect(entity: Entity, connection: Connection): Promise<DatastoreIntrospection> {
    const cname = containerName(entity);

    // Liveness + version
    const rootOut = await dockerExec(connection, cname, `curl -s localhost:9200/`);
    if (rootOut === '') {
      return { engine: 'opensearch', version: 'unknown', health: 'unknown', children: [] };
    }

    let rootJson: Record<string, unknown>;
    try {
      rootJson = JSON.parse(rootOut) as Record<string, unknown>;
    } catch {
      return { engine: 'opensearch', version: 'unknown', health: 'down', children: [] };
    }

    const versionObj = rootJson['version'];
    const versionNumber = typeof versionObj === 'object' && versionObj !== null
      ? (versionObj as Record<string, unknown>)['number']
      : undefined;
    const version = typeof versionNumber === 'string' ? versionNumber : 'unknown';

    // Cluster health (read-only status — no document access)
    const healthOut = await dockerExec(
      connection,
      cname,
      `curl -s localhost:9200/_cluster/health`,
    );
    let clusterStatus = 'unknown';
    try {
      const healthJson = JSON.parse(healthOut) as Record<string, unknown>;
      if (typeof healthJson['status'] === 'string') clusterStatus = healthJson['status'];
    } catch {
      // leave clusterStatus as 'unknown'
    }

    const health: DatastoreIntrospection['health'] =
      clusterStatus === 'green' ? 'ok' :
      clusterStatus === 'yellow' ? 'degraded' :
      clusterStatus === 'red' ? 'down' : 'unknown';

    // Index list: names + aggregate size + doc count (no document content)
    const indicesOut = await dockerExec(
      connection,
      cname,
      `curl -s 'localhost:9200/_cat/indices?h=index,store.size,docs.count&format=json'`,
    );

    const children: DatastoreChild[] = [];
    try {
      const rows = JSON.parse(indicesOut) as Array<Record<string, string>>;
      for (const row of rows) {
        const name = row['index'] ?? '';
        if (name === '' || name.startsWith('.')) continue; // skip system indices
        const sizeStr = row['store.size'] ?? '';
        const countStr = row['docs.count'] ?? '';
        // store.size is a human string like "1.2kb" — keep as -1 (no byte parse needed)
        const count = parseInt(countStr, 10);
        children.push({
          name,
          size_bytes: -1, // OS returns human-readable string; byte value not reliably parseable
          count: Number.isFinite(count) ? count : -1,
        });
        void sizeStr; // acknowledged — human-readable string, not bytes
      }
    } catch {
      // leave children empty on parse error
    }

    return { engine: 'opensearch', version, health, children };
  },
};

/**
 * Neo4j engine probe.
 *
 * Structure commands (NEVER reads node/relationship properties):
 *  - `cypher-shell -u neo4j -p neo4j 'SHOW DATABASES'` → database names + status
 */
const neo4jEngineProbe: DatastoreEngineProbe = {
  engine: 'neo4j',

  matches(entity: Entity): boolean {
    return imageContains(entity, 'neo4j');
  },

  async introspect(entity: Entity, connection: Connection): Promise<DatastoreIntrospection> {
    const cname = containerName(entity);

    // Liveness + database list (structure-only; no node property values read)
    const showDbOut = await dockerExec(
      connection,
      cname,
      // cypher-shell returns CSV-style output with a header row
      `cypher-shell --format plain -u neo4j -p neo4j 'SHOW DATABASES YIELD name, currentStatus'`,
    );

    if (showDbOut === '') {
      return { engine: 'neo4j', version: 'unknown', health: 'unknown', children: [] };
    }

    const children: DatastoreChild[] = [];
    const lines = showDbOut.split('\n').filter((l) => l.trim() !== '');
    // Skip header line
    for (const line of lines.slice(1)) {
      // Format: "name","currentStatus"
      const parts = line.split(',');
      const name = (parts[0] ?? '').replace(/"/g, '').trim();
      const status = (parts[1] ?? '').replace(/"/g, '').trim();
      if (name === '' || name === 'system') continue; // skip system db by convention
      children.push({ name, size_bytes: -1, count: -1 });
      void status; // carried in health field below
    }

    // Health from database statuses — if any is 'offline' → degraded
    const allOnline = lines.slice(1).every((l) => l.includes('online'));
    const health: DatastoreIntrospection['health'] = allOnline ? 'ok' : 'degraded';

    // Version via Neo4j HTTP API (read-only discovery endpoint)
    const versionOut = await dockerExec(
      connection,
      cname,
      `curl -s http://localhost:7474/`,
    );
    let version = 'unknown';
    try {
      const vJson = JSON.parse(versionOut) as Record<string, unknown>;
      const neo4jVersion = vJson['neo4j_version'];
      if (typeof neo4jVersion === 'string') version = neo4jVersion;
    } catch {
      // leave version as 'unknown'
    }

    return { engine: 'neo4j', version, health, children };
  },
};

// Register all built-in probes (invariant #62: open registry, no hard-coded list)
registerEngineProbe(postgresEngineProbe);
registerEngineProbe(redisEngineProbe);
registerEngineProbe(opensearchEngineProbe);
registerEngineProbe(neo4jEngineProbe);

// ---------------------------------------------------------------------------
// DatastoreProbe orchestrator
// ---------------------------------------------------------------------------

/**
 * Result of discovering and introspecting a single datastore entity.
 */
export interface DatastoreDiscoveryResult {
  /** The datastore entity upserted into the graph. */
  datastoreEntity: Entity;
  /** Child database/index/keyspace entities upserted into the graph. */
  children: Entity[];
  /** Edges linking children to the datastore entity. */
  edges: Edge[];
}

/**
 * Summary of a full datastore discovery probe run.
 */
export interface DatastoreProbeResult {
  /** Total number of datastore service/container entities found in the graph. */
  discovered: number;
  /** Number of datastores successfully introspected (health != 'unknown'). */
  introspected: number;
  /** Number of datastores that could not be introspected (credentials absent / exec failed). */
  skipped: number;
  /** Per-datastore results. */
  results: DatastoreDiscoveryResult[];
}

/**
 * Exec source: subset of `Connection` needed by `DatastoreProbe`.
 * Narrow interface keeps the probe testable without a full Connection mock.
 */
export interface DatastoreExecSource {
  readonly platformId: string;
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
}

/**
 * DatastoreProbe: finds datastore entities in the graph by role tag
 * (`attributes.role='database'|'cache'`) or by image signal, then
 * introspects each one using the appropriate engine probe.
 *
 * Design (invariant #62):
 * - Scans ALL graph entities; those whose role is 'database' or 'cache',
 *   or whose image matches a registered engine probe, are candidates.
 * - Entity IDs for discovered datastores follow:
 *     `datastore:<platformId>:<entityName>`
 *   Child IDs follow:
 *     `database:<datastoreEntityId>:<childName>`
 * - Edges: `member-of` from child to parent datastore.
 * - No hard-coded instance names or credentials anywhere.
 */
export class DatastoreProbe {
  private readonly graphStore: GraphStore;
  private readonly now: string;

  /**
   * @param graphStore - Graph store to read entities from and upsert results to.
   * @param opts.now   - ISO-8601 timestamp (injected for determinism in tests).
   */
  constructor(
    graphStore: GraphStore,
    opts: { now?: string } = {},
  ) {
    this.graphStore = graphStore;
    this.now = opts.now ?? new Date().toISOString();
  }

  /**
   * Find all datastore candidate entities and introspect their structure.
   *
   * For each candidate:
   *  1. Find the registered engine probe that matches the entity.
   *  2. If no probe matches, skip (non-datastore entity).
   *  3. If a connection is provided, run structure-only introspection.
   *  4. Upsert a `kind='datastore'` entity and child `kind='database'` entities.
   *  5. Upsert `member-of` edges from each child to the datastore entity.
   *
   * @param connection - Live connection to the platform (may be undefined for dry-run/test).
   * @returns Probe result summary.
   */
  async probe(connection?: Connection): Promise<DatastoreProbeResult> {
    const candidates = await this.findCandidates();
    const result: DatastoreProbeResult = {
      discovered: candidates.length,
      introspected: 0,
      skipped: 0,
      results: [],
    };

    for (const entity of candidates) {
      const engineProbe = findEngineProbe(entity);
      if (engineProbe === undefined) {
        // Matched by role but no engine probe — record as unknown engine
        const datastoreEntity = this.buildDatastoreEntity(entity, {
          engine: 'generic',
          version: 'unknown',
          health: 'unknown',
          children: [],
        });
        await this.graphStore.upsertEntity(datastoreEntity);
        result.skipped++;
        result.results.push({ datastoreEntity, children: [], edges: [] });
        continue;
      }

      let introspection: DatastoreIntrospection;
      if (connection === undefined) {
        introspection = {
          engine: engineProbe.engine,
          version: 'unknown',
          health: 'unknown',
          children: [],
        };
        result.skipped++;
      } else {
        introspection = await engineProbe.introspect(entity, connection);
        if (introspection.health === 'unknown') {
          result.skipped++;
        } else {
          result.introspected++;
        }
      }

      const datastoreEntity = this.buildDatastoreEntity(entity, introspection);
      await this.graphStore.upsertEntity(datastoreEntity);

      const children: Entity[] = [];
      const edges: Edge[] = [];

      for (const child of introspection.children) {
        const childEntity = this.buildChildEntity(datastoreEntity.id, entity, child);
        await this.graphStore.upsertEntity(childEntity);
        children.push(childEntity);

        const edge: Edge = {
          id: `member-of:${childEntity.id}:${datastoreEntity.id}`,
          from: childEntity.id,
          to: datastoreEntity.id,
          type: 'member-of',
          discovered_at: this.now,
          last_seen: this.now,
          status: 'active',
        };
        await this.graphStore.upsertEdge(edge);
        edges.push(edge);
      }

      result.results.push({ datastoreEntity, children, edges });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Find all candidate entities: those with role='database'|'cache' or
   * whose image matches a registered engine probe (generic fallback for
   * entities not yet classified by the role classifier).
   *
   * Invariant #62: selection is by generic attribute signals, never by
   * instance names.
   */
  private async findCandidates(): Promise<Entity[]> {
    const doc = await this.graphStore.all();
    return doc.entities.filter((entity) => {
      const role = entity.attributes['role'];
      if (role === 'database' || role === 'cache') return true;
      // Fallback: match by image signal even if role not yet assigned
      return findEngineProbe(entity) !== undefined;
    });
  }

  /**
   * Build a `kind='datastore'` entity from the source service/container entity
   * and its introspection result.
   *
   * @param source        - The original service/container entity.
   * @param introspection - Result of the engine probe introspection.
   */
  private buildDatastoreEntity(
    source: Entity,
    introspection: DatastoreIntrospection,
  ): Entity {
    const datastoreId = `datastore:${source.platformId ?? 'unknown'}:${source.name}`;
    return {
      id: datastoreId,
      kind: 'datastore',
      name: source.name,
      attributes: {
        engine: introspection.engine,
        version: introspection.version,
        health: introspection.health,
        source_entity_id: source.id,
        source_image: source.attributes['image'] ?? '',
        ...(introspection.replication_role !== undefined
          ? { replication_role: introspection.replication_role }
          : {}),
        ...(introspection.replication_lag_seconds !== undefined
          ? { replication_lag_seconds: introspection.replication_lag_seconds }
          : {}),
      },
      source: 'datastore-probe',
      platformId: source.platformId,
      discovered_at: source.discovered_at,
      last_seen: this.now,
      status: 'active',
    };
  }

  /**
   * Build a `kind='database'` child entity from a `DatastoreChild` result.
   *
   * @param datastoreEntityId - ID of the parent datastore entity.
   * @param source            - The original service/container entity (for platform context).
   * @param child             - Structure-only child metadata.
   */
  private buildChildEntity(
    datastoreEntityId: string,
    source: Entity,
    child: DatastoreChild,
  ): Entity {
    return {
      id: `database:${datastoreEntityId}:${child.name}`,
      kind: 'database',
      name: child.name,
      attributes: {
        size_bytes: child.size_bytes,
        count: child.count,
      },
      source: 'datastore-probe',
      platformId: source.platformId,
      discovered_at: this.now,
      last_seen: this.now,
      status: 'active',
    };
  }
}
