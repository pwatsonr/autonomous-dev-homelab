/**
 * GraphStore: persisted entity+edge graph for the homelab inventory (v2).
 *
 * Implements issue #26 — the typed entity+edge graph model that the whole
 * control plane (portal, deploy, rules, observability) reads from.
 *
 * Design:
 * - Persists to `inventory-graph.yaml` (mode 0600) in the same data dir as
 *   the rest of the plugin. Uses the same atomic-write + per-file-mutex
 *   pattern as InventoryManager.
 * - Validates against `schemas/inventory-graph-v2.json` on every read/write.
 * - `kind` (entity) and `type` (edge) are open strings; the schema validates
 *   them only as non-empty strings. Unknown kinds/types are silently accepted
 *   (dynamic-first invariant, issue #62).
 * - `upsertEntity` / `upsertEdge` merge by id and refresh `last_seen`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteFile } from '../util/atomic-write.js';
import { fileMutex, type FileMutex } from '../util/file-mutex.js';
import type { Entity, Edge, GraphDocument } from './graph-types.js';

import schemaJson from '../../schemas/inventory-graph-v2.json';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateGraph: ValidateFunction = ajv.compile(schemaJson);

/** Stable error codes raised by GraphStore. */
export type GraphStoreErrorCode = 'INVALID_GRAPH';

export class GraphStoreError extends Error {
  public readonly code: GraphStoreErrorCode;
  constructor(code: GraphStoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GraphStoreError';
  }
}

// ---------------------------------------------------------------------------
// Shared in-process mutex (same pattern as InventoryManager)
// ---------------------------------------------------------------------------

const SHARED_MUTEX: FileMutex = fileMutex();

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

/**
 * In-memory + on-disk graph store backed by `inventory-graph.yaml`.
 *
 * All mutating operations serialize through a per-file mutex and write
 * atomically (tmp + fsync + rename). Mode 0600 keeps the file owner-only.
 */
export class GraphStore {
  private readonly graphFilePath: string;
  private readonly mutex: FileMutex;

  /**
   * @param graphFilePath - Absolute path to `inventory-graph.yaml`.
   * @param opts.mutex    - Override the shared mutex (tests inject an
   *                        isolated instance to avoid cross-test contention).
   */
  constructor(graphFilePath: string, opts: { mutex?: FileMutex } = {}) {
    this.graphFilePath = path.resolve(graphFilePath);
    this.mutex = opts.mutex ?? SHARED_MUTEX;
  }

  // -------------------------------------------------------------------------
  // Read queries (no mutex needed — reads are non-mutating)
  // -------------------------------------------------------------------------

  /**
   * Returns the entity with `id`, or `null` if absent.
   */
  async getEntity(id: string): Promise<Entity | null> {
    const doc = await this.readFile();
    return doc.entities.find((e) => e.id === id) ?? null;
  }

  /**
   * Returns all entities whose `kind` matches `kind` exactly.
   * Because `kind` is an open string this always succeeds for any value.
   */
  async entitiesByKind(kind: string): Promise<Entity[]> {
    const doc = await this.readFile();
    return doc.entities.filter((e) => e.kind === kind);
  }

  /**
   * Returns all edges incident to entity `id` (either direction), optionally
   * filtered to a specific edge `type`.
   *
   * @param id       - Entity id.
   * @param edgeType - Optional open-string edge type filter.
   */
  async edgesOf(id: string, edgeType?: string): Promise<Edge[]> {
    const doc = await this.readFile();
    let edges = doc.edges.filter((e) => e.from === id || e.to === id);
    if (edgeType !== undefined) {
      edges = edges.filter((e) => e.type === edgeType);
    }
    return edges;
  }

  /**
   * Returns entities directly connected to `id` via any edge (or via edges
   * of the given `type`). Includes both forward (from===id) and reverse
   * (to===id) neighbors.
   *
   * @param id       - Entity id.
   * @param edgeType - Optional open-string edge type filter.
   */
  async neighbors(id: string, edgeType?: string): Promise<Entity[]> {
    const doc = await this.readFile();
    let edges = doc.edges.filter((e) => e.from === id || e.to === id);
    if (edgeType !== undefined) {
      edges = edges.filter((e) => e.type === edgeType);
    }
    const neighborIds = new Set<string>();
    for (const edge of edges) {
      neighborIds.add(edge.from === id ? edge.to : edge.from);
    }
    return doc.entities.filter((e) => neighborIds.has(e.id));
  }

  /**
   * Returns the full graph document `{ version, entities, edges }`.
   */
  async all(): Promise<GraphDocument> {
    const doc = await this.readFile();
    return {
      version: doc.version,
      entities: [...doc.entities],
      edges: [...doc.edges],
    };
  }

  // -------------------------------------------------------------------------
  // Write operations (serialized through the mutex)
  // -------------------------------------------------------------------------

  /**
   * Upsert an entity by `id`:
   * - If an entity with the same `id` exists, merges `entity` over it and
   *   refreshes `last_seen` to `entity.last_seen` (caller supplies the
   *   timestamp so the store is deterministic in tests).
   * - If absent, inserts it.
   *
   * Unknown `kind` values are accepted without error (invariant #62).
   */
  async upsertEntity(entity: Entity): Promise<void> {
    const release = await this.mutex.acquire(this.graphFilePath);
    try {
      const doc = await this.readFile();
      const idx = doc.entities.findIndex((e) => e.id === entity.id);
      if (idx >= 0) {
        doc.entities[idx] = { ...doc.entities[idx]!, ...entity };
      } else {
        doc.entities.push({ ...entity });
      }
      await this.writeFile(doc);
    } finally {
      release();
    }
  }

  /**
   * Upsert an edge by `id`:
   * - If an edge with the same `id` exists, merges `edge` over it and
   *   refreshes `last_seen`.
   * - If absent, inserts it.
   *
   * Unknown `type` values are accepted without error (invariant #62).
   */
  async upsertEdge(edge: Edge): Promise<void> {
    const release = await this.mutex.acquire(this.graphFilePath);
    try {
      const doc = await this.readFile();
      const idx = doc.edges.findIndex((e) => e.id === edge.id);
      if (idx >= 0) {
        doc.edges[idx] = { ...doc.edges[idx]!, ...edge };
      } else {
        doc.edges.push({ ...edge });
      }
      await this.writeFile(doc);
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Read and validate the graph document. Returns empty doc if file absent. */
  private async readFile(): Promise<GraphDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.graphFilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, entities: [], edges: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new GraphStoreError(
        'INVALID_GRAPH',
        `failed to parse graph YAML: ${(err as Error).message}`,
      );
    }
    if (parsed === null || parsed === undefined) {
      return { version: 2, entities: [], edges: [] };
    }
    if (!validateGraph(parsed)) {
      const errs = (validateGraph.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join('; ');
      throw new GraphStoreError('INVALID_GRAPH', `graph failed schema validation: ${errs}`);
    }
    const doc = parsed as GraphDocument;
    return { version: doc.version, entities: [...doc.entities], edges: [...doc.edges] };
  }

  /** Validate and atomically write the graph document (mode 0600). */
  private async writeFile(doc: GraphDocument): Promise<void> {
    if (!validateGraph(doc)) {
      const errs = (validateGraph.errors ?? [])
        .map((e) => `${e.instancePath} ${e.message}`)
        .join('; ');
      throw new GraphStoreError('INVALID_GRAPH', `refusing to write invalid graph: ${errs}`);
    }
    const serialized = yaml.dump(doc, { noRefs: true, sortKeys: false });
    await atomicWriteFile(this.graphFilePath, serialized, { mode: 0o600 });
  }
}
