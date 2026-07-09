/**
 * Derived dependency-edge inference (issue #29).
 *
 * Pure graph analysis — no new connections or HTTP calls. Scans service and
 * container entities' `attributes` (env vars, labels, connection strings) for
 * references to OTHER entities' names, hosts, or ports, and emits
 * `depends-on` edges.
 *
 * Dynamic-first invariant (#62):
 * - No hard-coded service names or hostnames. Every match is derived
 *   from live graph data.
 * - Pattern extraction is generic: targets are found by comparing env-var
 *   string values against entity names, hosts, and ports.
 * - Dependency inference is additive — existing edges are left unchanged.
 *
 * Edge types emitted:
 *   - `depends-on`  — service→service or service→datastore (inferred from
 *                     env/label references to another entity's name/host/port)
 */

import type { Entity, Edge } from '../graph-types.js';
import type { GraphStore } from '../graph-store.js';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface DepEdgesResult {
  /** `depends-on` edges derived from graph analysis. */
  edges: Edge[];
  /** Number of source entities inspected. */
  sourcesInspected: number;
  /** Number of dependency edges derived. */
  edgesDerived: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface DepEdgesLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: DepEdgesLogger = {};

// ---------------------------------------------------------------------------
// Helper: extract string values from an entity's attributes
// ---------------------------------------------------------------------------

/**
 * Collect all leaf string values from an entity's `attributes` object.
 *
 * Handles:
 * - Plain string values (`attributes.foo = 'bar'`)
 * - String arrays (`attributes.ports = ['*:5432->5432/tcp']`)
 * - Object label maps (`attributes.labels = { 'com.example.db': 'postgres' }`)
 * - Comma-separated label strings (`attributes.labels = 'a=b,c=d'`)
 * - `attributes.env` — array of `KEY=value` strings or object map
 *
 * @param entity - The entity whose attributes to scan.
 * @returns Flat array of all string leaf values from the attributes.
 */
export function collectAttributeStrings(entity: Entity): string[] {
  const result: string[] = [];

  function walk(val: unknown): void {
    if (typeof val === 'string') {
      result.push(val);
      return;
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      result.push(String(val));
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) walk(item);
      return;
    }
    if (typeof val === 'object' && val !== null) {
      for (const v of Object.values(val)) walk(v);
      return;
    }
  }

  walk(entity.attributes);
  return result;
}

// ---------------------------------------------------------------------------
// Helper: build a lookup of "candidate strings" that identify each entity
// ---------------------------------------------------------------------------

/**
 * Build a set of identifier strings that represent a given entity.
 *
 * These are the strings we look for when scanning another entity's attributes:
 * - entity name (lowercase)
 * - `attributes.host` (lowercase)
 * - each port number string (just the numeric portion, e.g. '5432' from '*:5432->5432/tcp')
 *
 * @param entity - The entity to build identifiers for.
 * @returns Set of lowercase identifier strings.
 */
export function entityIdentifiers(entity: Entity): Set<string> {
  const ids = new Set<string>();

  // Entity name.
  if (entity.name !== '') {
    ids.add(entity.name.toLowerCase());
  }

  // Host attribute.
  const host = entity.attributes['host'];
  if (typeof host === 'string' && host !== '') {
    ids.add(host.toLowerCase());
  }

  // Port numbers from the ports array.
  const ports = entity.attributes['ports'];
  if (Array.isArray(ports)) {
    for (const p of ports) {
      if (typeof p !== 'string') continue;
      // Extract port number: both host and container port sides.
      const portNums = p.match(/\d+/g);
      if (portNums !== null) {
        for (const num of portNums) ids.add(num);
      }
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Helper: test whether a candidate string appears in an attribute string
// ---------------------------------------------------------------------------

/**
 * Test whether `candidate` (an entity identifier) appears as a meaningful
 * token inside `attrValue` (an attribute string from another entity).
 *
 * Rules:
 * - Candidate must be at least 4 characters (avoids false positives on
 *   short port numbers like '80' or '53' and very common words).
 * - Pure numeric candidates (port numbers) must appear as a word boundary
 *   token (preceded/followed by ':', '/', or string boundary) to avoid
 *   matching '8080' inside unrelated 16-digit strings.
 * - Non-numeric candidates (hostnames / service names) match as
 *   case-insensitive substring.
 *
 * @param attrValue - A string attribute value from the source entity.
 * @param candidate - An identifier from the target entity.
 * @returns True when the candidate is referenced in attrValue.
 */
export function candidateMatches(attrValue: string, candidate: string): boolean {
  if (candidate.length < 4) return false;
  const lower = attrValue.toLowerCase();
  const cand = candidate.toLowerCase();

  if (/^\d+$/.test(cand)) {
    // Numeric candidate (port): require word-boundary context.
    // Allow common separators before/after the port number: :, /, =, whitespace,
    // -, > (Docker port format "*:5432->5432/tcp"), and string start/end.
    const re = new RegExp(`(?:^|[:/=>\\-\\s])${cand}(?:$|[:/=>\\-\\s])`);
    return re.test(attrValue);
  }

  return lower.includes(cand);
}

// ---------------------------------------------------------------------------
// DependencyEdgeDeriver
// ---------------------------------------------------------------------------

/**
 * Options for the dependency-edge deriver.
 */
export interface DepEdgesOptions {
  /**
   * Clock override for deterministic timestamps in tests.
   * Defaults to `() => new Date().toISOString()`.
   */
  clock?: () => string;
  /**
   * Logger override.
   */
  logger?: DepEdgesLogger;
}

/**
 * Infers `depends-on` edges between entities by scanning their attributes.
 *
 * Pure graph analysis — no new connections. Works entirely on the in-memory
 * graph state already in the GraphStore.
 *
 * Algorithm:
 * 1. Load all service and container entities (sources).
 * 2. Load all service, container, and datastore entities (targets).
 * 3. For each source entity, collect all attribute string values.
 * 4. For each potential target (excluding self), check whether any of the
 *    target's identifiers appear in the source's attribute strings.
 * 5. Emit a `depends-on` edge for each match found.
 *
 * Edge IDs are deterministic: `depends-on:<sourceId>:<targetId>`.
 */
export class DependencyEdgeDeriver {
  private readonly graphStore: GraphStore;
  private readonly clock: () => string;
  private readonly logger: DepEdgesLogger;

  /**
   * @param graphStore - Source graph (read-only in this deriver).
   * @param opts       - Optional overrides.
   */
  constructor(graphStore: GraphStore, opts: DepEdgesOptions = {}) {
    this.graphStore = graphStore;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /**
   * Derive dependency edges from the current graph state.
   *
   * Does not modify the graph store — callers upsert the returned edges.
   *
   * @returns Derived `depends-on` edges and diagnostic counts.
   */
  async derive(): Promise<DepEdgesResult> {
    const now = this.clock();

    // Load source entities: services and containers.
    const [services, containers, datastores] = await Promise.all([
      this.graphStore.entitiesByKind('service'),
      this.graphStore.entitiesByKind('container'),
      this.graphStore.entitiesByKind('datastore'),
    ]);

    const sources: Entity[] = [...services, ...containers];
    const targets: Entity[] = [...services, ...containers, ...datastores];

    if (sources.length === 0 || targets.length === 0) {
      return { edges: [], sourcesInspected: 0, edgesDerived: 0 };
    }

    // Pre-compute identifier sets for every target.
    const targetIdentifiers = new Map<string, Set<string>>();
    for (const t of targets) {
      targetIdentifiers.set(t.id, entityIdentifiers(t));
    }

    const edges: Edge[] = [];
    const emitted = new Set<string>(); // dedup

    for (const source of sources) {
      const attrStrings = collectAttributeStrings(source);

      for (const target of targets) {
        // Skip self-references.
        if (target.id === source.id) continue;

        const edgeId = `depends-on:${source.id}:${target.id}`;
        if (emitted.has(edgeId)) continue;

        const idents = targetIdentifiers.get(target.id) ?? new Set<string>();
        let matched = false;

        outer: for (const attrVal of attrStrings) {
          for (const ident of idents) {
            if (candidateMatches(attrVal, ident)) {
              matched = true;
              break outer;
            }
          }
        }

        if (matched) {
          emitted.add(edgeId);
          const edge: Edge = {
            id: edgeId,
            from: source.id,
            to: target.id,
            type: 'depends-on',
            attributes: { derived: true },
            discovered_at: now,
            last_seen: now,
            status: 'active',
          };
          edges.push(edge);

          this.logger.debug?.('dep_edges_derived', {
            sourceId: source.id,
            targetId: target.id,
          });
        }
      }
    }

    this.logger.info?.('dep_edges_complete', {
      sourcesInspected: sources.length,
      edgesDerived: edges.length,
    });

    return {
      edges,
      sourcesInspected: sources.length,
      edgesDerived: edges.length,
    };
  }
}
