/**
 * RefreshEngine: continuous sweep-based drift detection for the inventory graph.
 *
 * Implements issue #31 — the engine that keeps the inventory graph in sync
 * as the homelab changes.
 *
 * Design:
 *  1. Runs a full deep-enumeration pass (upserts entities/edges, refreshing
 *     their `last_seen` to `now`).
 *  2. Reconciles: entities/edges whose `last_seen` is older than
 *     `stalenessThresholdMs` after the sweep are marked `stale`; those older
 *     than `goneThresholdMs` are marked `gone`. Neither is ever deleted —
 *     history is preserved (issue #31 AC).
 *  3. Computes a typed diff vs the prior graph snapshot: added entities,
 *     gone entities, and meaningful attribute changes (replica drop, image
 *     change).
 *  4. For each material drift event, emits an `Observation` into the existing
 *     pipeline (ObservationStore + DedupCache) so drift surfaces alongside
 *     fault observations. Promotion (→ autonomous-dev intake) is left to the
 *     shared ObservationPromoter.
 *
 * Dynamic-first (invariant #62):
 *  - No homelab-specific service or node names appear here. Drift detection
 *    is purely structural: it reads generic `attributes.replicas_running`,
 *    `attributes.replicas_desired`, and `attributes.image` keys. Any entity
 *    kind with those attributes is automatically covered.
 *  - Adding or removing a service between two sweeps produces a diff entry
 *    with no code change required.
 *
 * The RefreshEngine is a pure on-demand sweep executor. Daemonization /
 * scheduling is a follow-up concern; callers (CLI, daemon) invoke `sweep()`
 * repeatedly at their chosen cadence.
 */

import { randomUUID } from 'node:crypto';
import type { DeepEnumerator } from './deep-enumerator.js';
import type { GraphStore } from './graph-store.js';
import type { Entity, Edge } from './graph-types.js';
import type { ObservationStore } from '../observation/persistence.js';
import type { DedupCache } from '../observation/dedup.js';
import type { Observation } from '../observation/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Thresholds controlling staleness and gone transitions.
 *
 * Defaults:
 *  - `stalenessThresholdMs`:  5 minutes  (entity unseen for one missed sweep)
 *  - `goneThresholdMs`:       30 minutes (entity unseen for several sweeps)
 */
export interface RefreshThresholds {
  /** Ms after `sweep start` at which an entity/edge transitions active → stale. */
  stalenessThresholdMs: number;
  /** Ms after `sweep start` at which an entity/edge transitions stale → gone. */
  goneThresholdMs: number;
}

const DEFAULT_THRESHOLDS: RefreshThresholds = {
  stalenessThresholdMs: 5 * 60_000,   // 5 min
  goneThresholdMs:       30 * 60_000,  // 30 min
};

// ---------------------------------------------------------------------------
// Drift diff types
// ---------------------------------------------------------------------------

/** A single entity that appeared for the first time in this sweep. */
export interface AddedEntityEvent {
  kind: 'entity_added';
  entity: Entity;
}

/** An entity whose `status` transitioned to `'gone'` in this sweep. */
export interface GoneEntityEvent {
  kind: 'entity_gone';
  entity: Entity;
}

/**
 * A service whose `replicas_running` attribute dropped below
 * `replicas_desired` in this sweep.
 */
export interface ReplicaMismatchEvent {
  kind: 'replica_mismatch';
  entity: Entity;
  /** Running replica count observed in this sweep. */
  replicasRunning: number;
  /** Desired replica count observed in this sweep. */
  replicasDesired: number;
}

/** An entity whose `image` attribute changed between sweeps. */
export interface ImageChangedEvent {
  kind: 'image_changed';
  entity: Entity;
  /** Image value from the previous sweep. */
  previousImage: string;
  /** Image value from this sweep. */
  currentImage: string;
}

/** Union of all drift change event types. */
export type DriftEvent =
  | AddedEntityEvent
  | GoneEntityEvent
  | ReplicaMismatchEvent
  | ImageChangedEvent;

// ---------------------------------------------------------------------------
// Sweep result
// ---------------------------------------------------------------------------

/** Summary of a single `RefreshEngine.sweep()` run. */
export interface SweepResult {
  /** ISO-8601 timestamp when the sweep started. */
  sweepAt: string;
  /** Counts from the deep-enumeration pass. */
  entitiesUpserted: number;
  edgesUpserted: number;
  /** Number of platforms that failed to enumerate (connection/enumerator absent). */
  platformsFailed: number;
  /** Number of entities transitioned to `stale`. */
  markedStale: number;
  /** Number of entities transitioned to `gone`. */
  markedGone: number;
  /** Typed drift events detected in this sweep. */
  driftEvents: DriftEvent[];
  /** Observations emitted into the pipeline for material drift events. */
  observationsEmitted: number;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface RefreshLogger {
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
  debug?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: RefreshLogger = {};

// ---------------------------------------------------------------------------
// RefreshEngine
// ---------------------------------------------------------------------------

/**
 * On-demand inventory refresh engine.
 *
 * Call `sweep()` to run one incremental refresh. The engine:
 *  - delegates enumeration to the injected `DeepEnumerator`,
 *  - reads the prior graph state from `GraphStore`,
 *  - reconciles staleness/gone transitions,
 *  - computes a typed drift diff,
 *  - emits material drift as `Observation` records.
 */
export class RefreshEngine {
  private readonly deepEnumerator: DeepEnumerator;
  private readonly graphStore: GraphStore;
  private readonly observationStore: ObservationStore;
  private readonly dedupCache: DedupCache;
  private readonly thresholds: RefreshThresholds;
  private readonly logger: RefreshLogger;
  /** Clock injection for deterministic tests. */
  private readonly clock: () => string;

  /**
   * @param deepEnumerator   - Runs the per-platform enumeration passes.
   * @param graphStore       - Source + sink for the persistent entity/edge graph.
   * @param observationStore - Where drift observations are persisted.
   * @param dedupCache       - Shared dedup window (prevents re-emitting within 1h).
   * @param opts.thresholds  - Staleness/gone thresholds (defaults: 5 min / 30 min).
   * @param opts.logger      - Optional structured logger.
   * @param opts.clock       - Optional ISO-8601 clock override (tests inject).
   */
  constructor(
    deepEnumerator: DeepEnumerator,
    graphStore: GraphStore,
    observationStore: ObservationStore,
    dedupCache: DedupCache,
    opts: {
      thresholds?: Partial<RefreshThresholds>;
      logger?: RefreshLogger;
      clock?: () => string;
    } = {},
  ) {
    this.deepEnumerator = deepEnumerator;
    this.graphStore = graphStore;
    this.observationStore = observationStore;
    this.dedupCache = dedupCache;
    this.thresholds = {
      stalenessThresholdMs:
        opts.thresholds?.stalenessThresholdMs ?? DEFAULT_THRESHOLDS.stalenessThresholdMs,
      goneThresholdMs:
        opts.thresholds?.goneThresholdMs ?? DEFAULT_THRESHOLDS.goneThresholdMs,
    };
    this.logger = opts.logger ?? NULL_LOGGER;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /**
   * Run one full refresh sweep.
   *
   * Steps:
   *  1. Snapshot the current graph state (for diff).
   *  2. Run deep enumeration (upserts entities/edges, refreshes `last_seen`).
   *  3. Reconcile: mark stale/gone based on `last_seen` vs sweep start time.
   *  4. Compute drift diff vs the pre-sweep snapshot.
   *  5. Emit material drift events as observations.
   *
   * Unreachable platforms produce a `platformsFailed` count increment; they
   * do NOT trigger a mass-gone transition (issue #31 AC: "refresh of an
   * unreachable platform is a no-op, not a mass-missing sweep").
   *
   * @param opts.platformFilter - Enumerate only these platform IDs (default: all).
   * @returns Summary of the sweep.
   */
  async sweep(opts: { platformFilter?: string[] } = {}): Promise<SweepResult> {
    const sweepAt = this.clock();
    const sweepMs = new Date(sweepAt).getTime();

    this.logger.info?.('refresh_sweep_start', { sweepAt });

    // -----------------------------------------------------------------
    // 1. Snapshot prior graph state (entities only — diff is entity-centric).
    // -----------------------------------------------------------------
    const priorDoc = await this.graphStore.all();
    const priorById = new Map<string, Entity>();
    for (const e of priorDoc.entities) {
      priorById.set(e.id, e);
    }

    // -----------------------------------------------------------------
    // 2. Run deep enumeration. Upserts refresh last_seen to sweepAt.
    // -----------------------------------------------------------------
    const enumResult = await this.deepEnumerator.enumerate(
      opts.platformFilter !== undefined ? { platformFilter: opts.platformFilter } : {},
    );

    const succeededPlatformIds = new Set(
      enumResult.summaries.filter((s) => s.ok).map((s) => s.platformId),
    );
    const platformsFailed = enumResult.summaries.filter((s) => !s.ok).length;

    this.logger.debug?.('refresh_enum_done', {
      platforms_ok: succeededPlatformIds.size,
      platforms_failed: platformsFailed,
      entities_upserted: enumResult.totalEntities,
      edges_upserted: enumResult.totalEdges,
    });

    // -----------------------------------------------------------------
    // 3. Reconcile staleness/gone for all entities.
    //    Only consider entities belonging to platforms that SUCCEEDED this
    //    sweep; entities on failed platforms are not transitioned (no-op).
    // -----------------------------------------------------------------
    const currentDoc = await this.graphStore.all();

    let markedStale = 0;
    let markedGone = 0;

    for (const entity of currentDoc.entities) {
      // Only reconcile entities whose platform was successfully enumerated.
      // If platformId is absent (cross-platform entities), skip reconciliation.
      if (entity.platformId === undefined || !succeededPlatformIds.has(entity.platformId)) {
        continue;
      }
      // Already gone — nothing to do.
      if (entity.status === 'gone') continue;

      const lastSeenMs = new Date(entity.last_seen).getTime();
      const ageMs = sweepMs - lastSeenMs;

      if (ageMs >= this.thresholds.goneThresholdMs) {
        await this.graphStore.upsertEntity({ ...entity, status: 'gone' });
        markedGone++;
      } else if (
        ageMs >= this.thresholds.stalenessThresholdMs &&
        entity.status === 'active'
      ) {
        await this.graphStore.upsertEntity({ ...entity, status: 'stale' });
        markedStale++;
      }
    }

    // Reconcile edges similarly.
    for (const edge of currentDoc.edges) {
      if (edge.status === 'gone') continue;
      // Only reconcile edges where both endpoints belong to succeeded platforms
      // (edge platformId is not present, so use from/to entity lookup).
      const fromEntity = currentDoc.entities.find((e) => e.id === edge.from);
      const toEntity = currentDoc.entities.find((e) => e.id === edge.to);
      const edgePlatformId =
        fromEntity?.platformId ?? toEntity?.platformId;
      if (edgePlatformId === undefined || !succeededPlatformIds.has(edgePlatformId)) {
        continue;
      }

      const lastSeenMs = new Date(edge.last_seen).getTime();
      const ageMs = sweepMs - lastSeenMs;

      if (ageMs >= this.thresholds.goneThresholdMs) {
        await this.graphStore.upsertEdge({ ...edge, status: 'gone' });
      } else if (ageMs >= this.thresholds.stalenessThresholdMs && edge.status === 'active') {
        await this.graphStore.upsertEdge({ ...edge, status: 'stale' });
      }
    }

    this.logger.debug?.('refresh_reconcile_done', { markedStale, markedGone });

    // -----------------------------------------------------------------
    // 4. Compute typed drift diff vs the pre-sweep snapshot.
    // -----------------------------------------------------------------
    const postDoc = await this.graphStore.all();
    const driftEvents = this.computeDiff(priorById, postDoc.entities, succeededPlatformIds);

    // -----------------------------------------------------------------
    // 5. Emit material drift events as observations.
    // -----------------------------------------------------------------
    let observationsEmitted = 0;
    for (const event of driftEvents) {
      const obs = this.buildObservation(event, sweepAt);
      if (obs === null) continue;
      if (this.dedupCache.isDuplicate(obs, sweepMs)) {
        this.logger.debug?.('refresh_drift_dedup', { dedup_key: obs.dedup_key });
        continue;
      }
      try {
        await this.observationStore.save(obs);
        observationsEmitted++;
        this.logger.info?.('refresh_drift_emitted', {
          pattern: obs.pattern,
          resource: obs.resource,
          platform: obs.platform,
        });
      } catch (err) {
        this.logger.warn?.('refresh_drift_save_failed', {
          pattern: obs.pattern,
          error: (err as Error).message,
        });
      }
    }

    const result: SweepResult = {
      sweepAt,
      entitiesUpserted: enumResult.totalEntities,
      edgesUpserted: enumResult.totalEdges,
      platformsFailed,
      markedStale,
      markedGone,
      driftEvents,
      observationsEmitted,
    };

    this.logger.info?.('refresh_sweep_done', {
      sweepAt,
      entitiesUpserted: result.entitiesUpserted,
      edgesUpserted: result.edgesUpserted,
      platformsFailed: result.platformsFailed,
      markedStale: result.markedStale,
      markedGone: result.markedGone,
      driftEvents: result.driftEvents.length,
      observationsEmitted: result.observationsEmitted,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Diff computation
  // ---------------------------------------------------------------------------

  /**
   * Compute a typed drift diff between the pre-sweep snapshot and the
   * post-reconciliation graph.
   *
   * Covered signals (generic — no instance-specific names):
   *  - `entity_added`: entity id absent from prior snapshot.
   *  - `entity_gone`:  entity whose status is now `'gone'` (was active/stale).
   *  - `replica_mismatch`: `attributes.replicas_running < attributes.replicas_desired`.
   *  - `image_changed`: `attributes.image` differs from prior value.
   *
   * Only entities belonging to platforms that succeeded this sweep are
   * considered (prevents false-positive gone events for unreachable platforms).
   */
  private computeDiff(
    priorById: Map<string, Entity>,
    postEntities: Entity[],
    succeededPlatformIds: Set<string>,
  ): DriftEvent[] {
    const events: DriftEvent[] = [];

    for (const entity of postEntities) {
      // Only diff entities whose platform succeeded this sweep.
      if (entity.platformId === undefined || !succeededPlatformIds.has(entity.platformId)) {
        continue;
      }

      const prior = priorById.get(entity.id);

      if (prior === undefined) {
        // Brand-new entity.
        events.push({ kind: 'entity_added', entity });
        continue;
      }

      // Gone transition.
      if (entity.status === 'gone' && prior.status !== 'gone') {
        events.push({ kind: 'entity_gone', entity });
      }

      // Replica mismatch (generic — any entity kind with these attributes).
      const running = entity.attributes['replicas_running'];
      const desired = entity.attributes['replicas_desired'];
      if (
        typeof running === 'number' &&
        typeof desired === 'number' &&
        running < desired
      ) {
        events.push({
          kind: 'replica_mismatch',
          entity,
          replicasRunning: running,
          replicasDesired: desired,
        });
      }

      // Image change (generic — any entity with an `image` attribute).
      const currentImage = entity.attributes['image'];
      const priorImage = prior.attributes['image'];
      if (
        typeof currentImage === 'string' &&
        typeof priorImage === 'string' &&
        currentImage !== priorImage
      ) {
        events.push({
          kind: 'image_changed',
          entity,
          previousImage: priorImage,
          currentImage,
        });
      }
    }

    return events;
  }

  // ---------------------------------------------------------------------------
  // Observation builder
  // ---------------------------------------------------------------------------

  /**
   * Build an `Observation` record for a material drift event.
   *
   * Maps:
   *  - `entity_gone`      → pattern `entity_gone`,      severity P1
   *  - `replica_mismatch` → pattern `replica_mismatch`, severity P1
   *  - `image_changed`    → pattern `image_changed`,    severity P2
   *  - `entity_added`     → null (informational only; not a fault)
   *
   * The resource field is `<entity.kind>/<entity.id>` for stable dedup keys
   * that survive renames.
   *
   * @returns The observation, or `null` if the event kind is non-material.
   */
  private buildObservation(event: DriftEvent, discoveredAt: string): Observation | null {
    if (event.kind === 'entity_added') {
      // Additions are informational — they appear in the diff but are not faults.
      return null;
    }

    const entity = event.entity;
    const platformId = entity.platformId ?? 'unknown';
    const resource = `${entity.kind}/${entity.id}`;

    let pattern: Observation['pattern'];
    let severity: Observation['severity'];
    let details: Record<string, unknown>;

    switch (event.kind) {
      case 'entity_gone':
        pattern = 'entity_gone';
        severity = 'P1';
        details = {
          entity_kind: entity.kind,
          entity_name: entity.name,
          last_seen: entity.last_seen,
        };
        break;

      case 'replica_mismatch':
        pattern = 'replica_mismatch';
        severity = 'P1';
        details = {
          entity_kind: entity.kind,
          entity_name: entity.name,
          replicas_running: event.replicasRunning,
          replicas_desired: event.replicasDesired,
        };
        break;

      case 'image_changed':
        pattern = 'image_changed';
        severity = 'P2';
        details = {
          entity_kind: entity.kind,
          entity_name: entity.name,
          previous_image: event.previousImage,
          current_image: event.currentImage,
        };
        break;

      default: {
        // Exhaustive check: TypeScript narrows to `never` here.
        const _exhaustive: never = event;
        void _exhaustive;
        return null;
      }
    }

    const dedup_key = `${platformId}:${pattern}:${resource}`;
    const obs: Observation = {
      id: randomUUID(),
      platform: platformId,
      pattern,
      resource,
      severity,
      discovered_at: discoveredAt,
      details,
      dedup_key,
    };
    return obs;
  }
}
