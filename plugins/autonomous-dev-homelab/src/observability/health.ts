/**
 * Generic rolling health score for any inventory graph entity (issue #40,
 * invariant #62 — dynamic-first, no hard-coded service names).
 *
 * ## Scoring model
 *
 * Starting from a perfect score of 100, penalties are applied in order:
 *
 * 1. **Status penalty** — driven by `entity.status`:
 *    - `"stale"`: −20 (entity is no longer seen on last sweep)
 *    - `"gone"`:  −60 (entity has disappeared from the inventory)
 *
 * 2. **Replica shortfall** — when `attributes.replicas_desired > 0`:
 *    ```
 *    shortfall_ratio = (desired − running) / desired
 *    penalty = shortfall_ratio × REPLICA_WEIGHT     (default 40)
 *    ```
 *    Clamped so `shortfall_ratio` is in [0, 1].
 *
 * 3. **Observation penalty** — for each open observation whose `resource`
 *    matches the entity id:
 *    ```
 *    age_ms = now − discovered_at
 *    decay  = 0.5 ^ (age_ms / window_ms)    (half-life = window_ms)
 *    weight = P0 → 40 | P1 → 20 | P2 → 10
 *    contribution = weight × decay
 *    ```
 *    All contributions are summed and capped at `OBS_PENALTY_CAP` (default 70)
 *    before being subtracted from the running score.
 *
 * 4. **Floor**: score is clamped to [0, 100].
 *
 * ## Grade thresholds
 *
 * | Score range | Grade         |
 * |-------------|---------------|
 * | ≥ 80        | `"healthy"`   |
 * | 50 – 79     | `"degraded"`  |
 * | 0 – 49      | `"unhealthy"` |
 *
 * ## Purity contract
 *
 * `computeHealthScore` is a **pure function**: it never calls `Date.now()`.
 * The `now` timestamp (milliseconds since epoch) is always provided by the
 * caller — either explicitly via `opts.now`, or implicitly from
 * `HealthScorer` which supplies it. This makes the function fully
 * deterministic and trivially testable.
 */

import type { Entity } from '../discovery/graph-types.js';
import type { Observation, Severity } from '../observation/types.js';
import type { ObservationStore } from '../observation/persistence.js';
import type { GraphStore } from '../discovery/graph-store.js';

// ---------------------------------------------------------------------------
// Tuneable constants (documented + exported so callers can supply overrides)
// ---------------------------------------------------------------------------

/** Maximum score penalty that open observations can contribute. */
export const DEFAULT_OBS_PENALTY_CAP = 70;

/** Weight (score points) for a P0 observation before recency decay. */
export const DEFAULT_WEIGHT_P0 = 40;

/** Weight (score points) for a P1 observation before recency decay. */
export const DEFAULT_WEIGHT_P1 = 20;

/** Weight (score points) for a P2 observation before recency decay. */
export const DEFAULT_WEIGHT_P2 = 10;

/** Default rolling window in milliseconds (24 hours = observation half-life). */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Score penalty for a `"stale"` entity status (not seen on last sweep). */
export const STATUS_PENALTY_STALE = 20;

/** Score penalty for a `"gone"` entity status (disappeared from inventory). */
export const STATUS_PENALTY_GONE = 60;

/** Score penalty weight for a replica shortfall (full shortfall = this many points). */
export const DEFAULT_REPLICA_WEIGHT = 40;

/** Score at-or-above which the grade is `"healthy"`. */
export const GRADE_HEALTHY_THRESHOLD = 80;

/** Score at-or-above which the grade is `"degraded"` (below is `"unhealthy"`). */
export const GRADE_DEGRADED_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Optional SLO spec that an operator can associate with an entity. */
export interface SloSpec {
  /**
   * Target score (0–100). When specified, scores below this target are
   * highlighted as out-of-SLO by the caller. The scorer itself does not use
   * this value for calculation — it is purely declarative metadata.
   *
   * @defaultValue 80 (healthy threshold)
   */
  target?: number;
  /**
   * Rolling window for observation decay, as a human-readable string.
   * Supported suffixes: `m` (minutes), `h` (hours), `d` (days).
   * When absent, `opts.windowMs` or `DEFAULT_WINDOW_MS` is used.
   *
   * @example "24h", "7d", "30m"
   */
  window?: string;
}

/** Configurable weights/thresholds for `computeHealthScore`. */
export interface HealthScoringOptions {
  /**
   * `now` as milliseconds since epoch. **REQUIRED** for deterministic
   * scoring — the pure path never calls `Date.now()`.
   */
  now: number;
  /**
   * Rolling window in milliseconds. Observations older than this window
   * decay to ~0 contribution. Default: `DEFAULT_WINDOW_MS` (24 h).
   */
  windowMs?: number;
  /**
   * Maximum score penalty attributable to observations (before replica or
   * status penalties). Default: `DEFAULT_OBS_PENALTY_CAP` (70).
   */
  obsPenaltyCap?: number;
  /** Weight for P0 observations (before decay). Default: `DEFAULT_WEIGHT_P0` (40). */
  weightP0?: number;
  /** Weight for P1 observations (before decay). Default: `DEFAULT_WEIGHT_P1` (20). */
  weightP1?: number;
  /** Weight for P2 observations (before decay). Default: `DEFAULT_WEIGHT_P2` (10). */
  weightP2?: number;
  /**
   * Penalty weight for a full replica shortfall (running=0, desired>0).
   * Default: `DEFAULT_REPLICA_WEIGHT` (40).
   */
  replicaWeight?: number;
}

/** Result returned by `computeHealthScore`. */
export interface HealthScore {
  /**
   * Numeric score in [0, 100]. Higher is healthier.
   * 100 = perfect; 0 = completely unhealthy.
   */
  score: number;
  /** Human-readable grade derived from the score. */
  grade: 'healthy' | 'degraded' | 'unhealthy';
  /**
   * Ordered list of human-readable explanations for penalties applied.
   * Empty when the entity is fully healthy (score = 100).
   */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a window string like "30m", "1h", "7d" into milliseconds.
 * Returns `null` when the format is unrecognised.
 *
 * @param s - Window string to parse.
 * @returns Milliseconds, or `null` on parse failure.
 */
export function parseWindowMs(s: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(s);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? '0', 10);
  const unit = m[2];
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/**
 * Severity → raw weight mapping.
 *
 * @param severity - Observation severity.
 * @param weights  - Weight values keyed by lowercase severity.
 * @returns Raw weight for the given severity.
 */
function severityWeight(
  severity: Severity,
  weights: { p0: number; p1: number; p2: number },
): number {
  switch (severity) {
    case 'P0':
      return weights.p0;
    case 'P1':
      return weights.p1;
    case 'P2':
      return weights.p2;
  }
}

// ---------------------------------------------------------------------------
// Core pure function
// ---------------------------------------------------------------------------

/**
 * Compute a rolling health score for a graph entity given its open
 * observations.
 *
 * **Pure function**: never calls `Date.now()`. The `opts.now` parameter
 * carries the reference timestamp so scoring is deterministic and testable.
 *
 * Scoring model (see module-level JSDoc for full details):
 * 1. Status penalty (stale / gone).
 * 2. Replica shortfall penalty (proportional to missing replicas).
 * 3. Observation penalty (severity-weighted, recency-decayed, capped).
 * 4. Floor at 0.
 *
 * @param entity       - Any inventory graph entity.
 * @param observations - The observations whose `resource` matches this entity
 *                       (caller is responsible for pre-filtering by resource).
 * @param opts         - Scoring options including the mandatory `now`
 *                       timestamp.
 * @returns `{ score, grade, reasons }`.
 */
export function computeHealthScore(
  entity: Entity,
  observations: Observation[],
  opts: HealthScoringOptions,
): HealthScore {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const obsPenaltyCap = opts.obsPenaltyCap ?? DEFAULT_OBS_PENALTY_CAP;
  const weights = {
    p0: opts.weightP0 ?? DEFAULT_WEIGHT_P0,
    p1: opts.weightP1 ?? DEFAULT_WEIGHT_P1,
    p2: opts.weightP2 ?? DEFAULT_WEIGHT_P2,
  };
  const replicaWeight = opts.replicaWeight ?? DEFAULT_REPLICA_WEIGHT;
  const now = opts.now;

  let score = 100;
  const reasons: string[] = [];

  // 1. Status penalty.
  if (entity.status === 'stale') {
    score -= STATUS_PENALTY_STALE;
    reasons.push(`entity status is stale (−${STATUS_PENALTY_STALE})`);
  } else if (entity.status === 'gone') {
    score -= STATUS_PENALTY_GONE;
    reasons.push(`entity status is gone (−${STATUS_PENALTY_GONE})`);
  }

  // 2. Replica shortfall penalty.
  const replicasDesired = entity.attributes['replicas_desired'];
  const replicasRunning = entity.attributes['replicas_running'];
  if (
    typeof replicasDesired === 'number' &&
    replicasDesired > 0 &&
    typeof replicasRunning === 'number'
  ) {
    const shortfall = Math.max(0, replicasDesired - replicasRunning);
    const shortfallRatio = Math.min(1, shortfall / replicasDesired);
    if (shortfallRatio > 0) {
      const penalty = shortfallRatio * replicaWeight;
      score -= penalty;
      reasons.push(
        `replica shortfall: ${replicasRunning}/${replicasDesired} running ` +
          `(−${penalty.toFixed(1)})`,
      );
    }
  }

  // 3. Observation penalty (severity-weighted + recency decay).
  if (observations.length > 0) {
    let totalObsPenalty = 0;
    for (const obs of observations) {
      const discoveredMs = Date.parse(obs.discovered_at);
      if (Number.isNaN(discoveredMs)) continue;
      const ageMs = Math.max(0, now - discoveredMs);
      // Recency decay: exponential half-life equal to windowMs.
      // At age=0 → decay=1.0; at age=windowMs → decay=0.5; at age=2*window → decay=0.25.
      const decay = Math.pow(0.5, ageMs / windowMs);
      const rawWeight = severityWeight(obs.severity, weights);
      totalObsPenalty += rawWeight * decay;
    }

    const cappedObsPenalty = Math.min(totalObsPenalty, obsPenaltyCap);
    if (cappedObsPenalty > 0) {
      score -= cappedObsPenalty;
      reasons.push(
        `${observations.length} open observation(s) (penalty: −${cappedObsPenalty.toFixed(1)}, ` +
          `raw: ${totalObsPenalty.toFixed(1)}, cap: ${obsPenaltyCap})`,
      );
    }
  }

  // 4. Clamp to [0, 100].
  score = Math.max(0, Math.min(100, score));

  // Derive grade.
  let grade: HealthScore['grade'];
  if (score >= GRADE_HEALTHY_THRESHOLD) {
    grade = 'healthy';
  } else if (score >= GRADE_DEGRADED_THRESHOLD) {
    grade = 'degraded';
  } else {
    grade = 'unhealthy';
  }

  return { score, grade, reasons };
}

// ---------------------------------------------------------------------------
// HealthScorer — reads the graph, computes scores, writes back attributes
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `HealthScorer`.
 */
export interface HealthScorerOptions {
  /** Graph store to read entities from and write scores back to. */
  graphStore: GraphStore;
  /** Observation store to retrieve open observations from. */
  observationStore: ObservationStore;
  /**
   * Rolling window for observation decay. Applies to all entities unless
   * overridden per-entity via `SloSpec.window`. Default: `DEFAULT_WINDOW_MS`.
   */
  windowMs?: number;
  /**
   * Observable lookback window: only observations discovered within this
   * many milliseconds are considered "open". Default: same as `windowMs`
   * (24 h), so day-old observations age-decay to 50 % contribution rather
   * than being excluded entirely.
   */
  lookbackMs?: number;
  /**
   * Per-entity SLO specs keyed by entity id. When an entity has a spec with
   * a `window`, that window overrides the global `windowMs` for that entity.
   * Invariant #62: specs are matched by entity id (a stable discovered
   * identifier), NOT by hard-coded service names.
   */
  sloSpecs?: Map<string, SloSpec>;
  /** Logger; defaults to a no-op. */
  logger?: { warn: (msg: string, err?: unknown) => void };
}

/**
 * Reads all entities from the graph, fetches their open observations, and
 * writes computed health scores back as `attributes.health_score` and
 * `attributes.health_grade` via `upsertEntity`.
 *
 * Invariant #62 compliance:
 * - Scores ANY entity from the graph, not just hard-coded service names.
 * - Observations are matched to entities by `obs.resource === entity.id`
 *   (the `resource` field in observations is always an entity id or a
 *   `kind/name` string that can be matched against the entity's id).
 * - SLO spec lookup uses entity id, not a predefined name list.
 *
 * Wiring note: call `HealthScorer.scoreAll(now)` after a scan/refresh
 * cycle. The `now` parameter makes the scorer deterministic in tests.
 */
export class HealthScorer {
  private readonly graphStore: GraphStore;
  private readonly observationStore: ObservationStore;
  private readonly windowMs: number;
  private readonly lookbackMs: number;
  private readonly sloSpecs: Map<string, SloSpec>;
  private readonly logger: { warn: (msg: string, err?: unknown) => void };

  /**
   * @param opts - Scoring configuration and injected stores.
   */
  constructor(opts: HealthScorerOptions) {
    this.graphStore = opts.graphStore;
    this.observationStore = opts.observationStore;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.lookbackMs = opts.lookbackMs ?? this.windowMs;
    this.sloSpecs = opts.sloSpecs ?? new Map();
    this.logger = opts.logger ?? { warn: (): void => undefined };
  }

  /**
   * Score all entities in the graph and write health attributes back.
   *
   * For each entity, the scorer:
   * 1. Fetches open observations for the entity from the observation store
   *    (filtered by `resource === entity.id` or resource starts with
   *    `kind/name`).
   * 2. Calls `computeHealthScore(entity, matchingObservations, opts)`.
   * 3. Writes `attributes.health_score` and `attributes.health_grade` back
   *    to the entity via `graphStore.upsertEntity`.
   *
   * Errors during scoring of a single entity are logged and skipped; the
   * rest of the entities are still scored (fault isolation).
   *
   * **Pure path**: `now` is injected so the scorer is deterministic in tests.
   * `Date.now()` is called only once at the top of the `scoreAll` call when
   * no `now` is provided; the pure `computeHealthScore` never calls it.
   *
   * @param now - Reference timestamp (ms since epoch). Defaults to
   *              `Date.now()` when not provided — the single point where
   *              wall-clock time enters the scoring path.
   * @returns Number of entities scored.
   */
  async scoreAll(now: number = Date.now()): Promise<number> {
    // Load all entities from the graph.
    let allEntities: Entity[];
    try {
      const doc = await this.graphStore.all();
      allEntities = doc.entities;
    } catch (err) {
      this.logger.warn('HealthScorer: failed to load graph entities', err);
      return 0;
    }

    if (allEntities.length === 0) return 0;

    // Load recent observations (within lookback window) once, then partition
    // per entity below. This avoids N store reads for N entities.
    let allObservations: Observation[];
    try {
      allObservations = await this.observationStore.list({
        since: new Date(now - this.lookbackMs),
      });
    } catch (err) {
      this.logger.warn('HealthScorer: failed to load observations', err);
      allObservations = [];
    }

    // Build a resource→observations index for O(1) per-entity lookup.
    const byResource = new Map<string, Observation[]>();
    for (const obs of allObservations) {
      const existing = byResource.get(obs.resource);
      if (existing !== undefined) {
        existing.push(obs);
      } else {
        byResource.set(obs.resource, [obs]);
      }
    }

    let scored = 0;
    for (const entity of allEntities) {
      try {
        // Collect observations that match this entity.
        // Primary match: obs.resource === entity.id.
        // Secondary match: obs.resource === `${entity.kind}/${entity.name}`
        // (some probes emit "Pod/web-7c" style resources; this keeps scoring
        // generic — any entity's kind/name combo is checked automatically).
        const entityObs: Observation[] = [];
        const directMatch = byResource.get(entity.id);
        if (directMatch !== undefined) {
          entityObs.push(...directMatch);
        }
        const kindName = `${entity.kind}/${entity.name}`;
        if (kindName !== entity.id) {
          const kindNameMatch = byResource.get(kindName);
          if (kindNameMatch !== undefined) {
            for (const obs of kindNameMatch) {
              if (!entityObs.includes(obs)) entityObs.push(obs);
            }
          }
        }

        // Resolve per-entity window from SLO spec if present.
        const sloSpec = this.sloSpecs.get(entity.id);
        let windowMs = this.windowMs;
        if (sloSpec?.window !== undefined) {
          const parsed = parseWindowMs(sloSpec.window);
          if (parsed !== null) windowMs = parsed;
        }

        const result = computeHealthScore(entity, entityObs, { now, windowMs });

        // Write scores back to the graph entity's attributes.
        await this.graphStore.upsertEntity({
          ...entity,
          attributes: {
            ...entity.attributes,
            health_score: result.score,
            health_grade: result.grade,
          },
        });
        scored++;
      } catch (err) {
        this.logger.warn(`HealthScorer: failed to score entity ${entity.id}`, err);
      }
    }

    return scored;
  }
}
