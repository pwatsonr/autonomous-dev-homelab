/**
 * `CapacityProbe`: observes storage fill ratios and growth rates for
 * every capacity-bearing entity in the inventory graph (issue #44,
 * invariant #62).
 *
 * Dynamic-first design: all targets come from the graph. The probe
 * iterates whatever the graph has — no hard-coded share, pool, or
 * datastore names. New entities discovered on the next refresh sweep
 * are automatically covered on the next probe cadence.
 *
 * Entity kinds probed (generic attribute detection):
 *   - `storage-array`  — Unraid md RAID array (total/used from `df`)
 *   - `storage-disk`   — individual Unraid member disk (`df`)
 *   - `share`          — Unraid user share (`df` on /mnt/<name>)
 *   - `datastore`      — database data-dirs (disk_used/disk_limit attrs)
 *   - `pool`           — ZFS pools (`zpool list -Hp`)
 *
 * Capacity signals: for kinds that expose `size_bytes`/`used_bytes`
 * (or equivalent) in their graph attributes the probe uses those
 * directly (they were current at last discovery sweep).  For filesystem-
 * bearing kinds (`storage-array`, `storage-disk`, `share`) the probe
 * also issues a live `df -PB1 <path>` over the connection so the
 * reading is as fresh as possible.  For ZFS pools it issues
 * `zpool list -Hp <name>` (size + alloc fields).
 *
 * Growth-rate tracking: the probe stores the last sample for every
 * target in memory. On subsequent runs it computes a fill-rate
 * (bytes/second) and, when positive, projects the seconds-to-full
 * window. Both the fill-rate and the projected days-to-full appear in
 * the observation `details`.
 *
 * Thresholds (configurable; issue #44 AC):
 *   - warn threshold  (default 0.80 = 80 %) → capacity_warning P1
 *   - critical threshold (default 0.90 = 90 %) → capacity_critical P0
 *   - growth projection window (default 7 days): emit capacity_growth
 *     P1 when projected to full within that window even if current fill
 *     is below warn.
 *
 * Graceful degradation: a per-target exec failure or missing attribute
 * is caught and that target is skipped; the probe continues with the
 * remaining targets and returns all observations it could collect.
 *
 * Reuses `BaseProbe.makeObservation` and the dedup contract of the
 * collector (one observation per <platform>:<pattern>:<resource>).
 */

import type { Entity } from '../../discovery/graph-types.js';
import type { GraphStore } from '../../discovery/graph-store.js';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

// ---------------------------------------------------------------------------
// Exec source interface
// ---------------------------------------------------------------------------

/**
 * Minimal exec interface the probe needs. Matches the subset of
 * `Connection` actually used and allows simple test doubles.
 */
export interface CapacityExecSource {
  readonly platformId: string;
  exec(command: string): Promise<{ stdout: string; exitCode?: number }>;
}

// ---------------------------------------------------------------------------
// Per-target sample record (for growth-rate tracking)
// ---------------------------------------------------------------------------

/**
 * One sampled reading: used bytes + total bytes at a given epoch ms.
 */
export interface CapacitySample {
  usedBytes: number;
  totalBytes: number;
  /** Epoch milliseconds when the sample was taken. */
  sampledAt: number;
}

// ---------------------------------------------------------------------------
// Kinds the probe recognises as capacity-bearing
// ---------------------------------------------------------------------------

const CAPACITY_KINDS = [
  'storage-array',
  'storage-disk',
  'share',
  'datastore',
  'pool',
] as const;

type CapacityKind = (typeof CAPACITY_KINDS)[number];

function isCapacityKind(kind: string): kind is CapacityKind {
  return (CAPACITY_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for `CapacityProbe`.
 *
 * Thresholds are fractions (0..1), not percentages.
 */
export interface CapacityProbeOptions {
  /**
   * Platform identifier this probe reports against.
   */
  platformId: string;

  /**
   * Graph store used to enumerate capacity-bearing entities.
   */
  graphStore: GraphStore;

  /**
   * Exec source used for live `df` / `zpool list` commands.
   * When omitted the probe relies solely on graph attributes.
   */
  execSource?: CapacityExecSource;

  /**
   * Fill-ratio above which a `capacity_warning` (P1) is emitted.
   * Default: 0.80 (80 %).
   */
  warnThreshold?: number;

  /**
   * Fill-ratio above which a `capacity_critical` (P0) is emitted.
   * Default: 0.90 (90 %).
   */
  criticalThreshold?: number;

  /**
   * Time window in seconds. When a target is projected to reach 100 %
   * fill within this window, a `capacity_growth` (P1) is emitted even
   * if the current fill is below `warnThreshold`.
   * Default: 7 days = 604 800 s.
   */
  growthWindowSeconds?: number;
}

// ---------------------------------------------------------------------------
// df -PB1 line parser
// ---------------------------------------------------------------------------

/**
 * Parse a single `df -PB1` output line.
 *
 * Posix-format (`df -P`) columns:
 *   Filesystem  1B-blocks  Used  Available  Use%  Mounted-on
 *
 * @param line - One data line from `df -PB1` output.
 * @returns `{ used, total }` in bytes, or `null` when parsing fails.
 */
export function parseDfLine(line: string): { used: number; total: number } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;

  // 1B-blocks → total; Used → used; Available → free
  const total = parseInt(parts[1] ?? '', 10);
  const used = parseInt(parts[2] ?? '', 10);

  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null;
  return { used, total };
}

// ---------------------------------------------------------------------------
// `zpool list -Hp <name>` parser
// ---------------------------------------------------------------------------

/**
 * Parse one line from `zpool list -Hp` (parseable, no header).
 *
 * Columns: name size alloc free ckpoint expandsz frag cap dedup health altroot
 * (`-H` removes header; `-p` prints exact numeric bytes.)
 *
 * @param line - One line of `zpool list -Hp` output.
 * @returns `{ used, total }` in bytes, or `null` when parsing fails.
 */
export function parseZpoolListLine(line: string): { used: number; total: number } | null {
  const parts = line.trim().split(/\t|\s+/);
  if (parts.length < 3) return null;

  // Column 1 = size (total), column 2 = alloc (used)
  const total = parseInt(parts[1] ?? '', 10);
  const used = parseInt(parts[2] ?? '', 10);

  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null;
  return { used, total };
}

// ---------------------------------------------------------------------------
// Mount-path derivation (for df probing)
// ---------------------------------------------------------------------------

/**
 * Derive a filesystem path to probe via `df` for a given entity kind.
 *
 * - `share`          → `/mnt/<entity.name>`
 * - `storage-array`  → `/mnt/user` (aggregate user share mount)
 * - `storage-disk`   → `/mnt/<slot>` where slot = `attributes.slot ?? entity.name`
 * - other kinds      → `null` (use graph attributes or zpool)
 *
 * @param entity - Graph entity.
 * @returns Mount path string, or `null` when df is not applicable.
 */
export function dfMountPath(entity: Entity): string | null {
  switch (entity.kind) {
    case 'share':
      return `/mnt/${entity.name}`;
    case 'storage-array':
      return '/mnt/user';
    case 'storage-disk': {
      const slot = typeof entity.attributes['slot'] === 'string'
        ? entity.attributes['slot']
        : entity.name;
      return `/mnt/${slot}`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Graph-attribute capacity reading
// ---------------------------------------------------------------------------

/**
 * Read capacity figures from entity attributes, trying multiple naming
 * conventions set by different discovery sources:
 *
 * - Unraid disks.ini: `size_bytes` (total), `used_bytes` (used)
 * - Datastore-probe:  `disk_limit_bytes` (total), `disk_used_bytes` (used)
 * - Generic fallback: `size` / `used` (plain numeric attrs)
 *
 * @param entity - Graph entity.
 * @returns `{ used, total }` in bytes, or `null` when unavailable.
 */
export function readCapacityFromAttributes(
  entity: Entity,
): { used: number; total: number } | null {
  const attrs = entity.attributes;

  // Try canonical naming first
  const candidates: Array<[string, string]> = [
    ['used_bytes', 'size_bytes'],
    ['disk_used_bytes', 'disk_limit_bytes'],
    ['used', 'size'],
  ];

  for (const [usedKey, totalKey] of candidates) {
    const rawUsed = attrs[usedKey];
    const rawTotal = attrs[totalKey];

    const used = typeof rawUsed === 'number'
      ? rawUsed
      : typeof rawUsed === 'string'
        ? parseInt(rawUsed, 10)
        : NaN;

    const total = typeof rawTotal === 'number'
      ? rawTotal
      : typeof rawTotal === 'string'
        ? parseInt(rawTotal, 10)
        : NaN;

    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      return { used, total };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// CapacityProbe
// ---------------------------------------------------------------------------

/**
 * Probe that enumerates all capacity-bearing entities from the graph and
 * emits utilisation and growth-rate observations.
 *
 * Cadence: `slow` (hourly) — capacity trends evolve slowly; hourly is
 * sufficient to give the operator 6+ hours notice at 80 % fill.
 */
export class CapacityProbe extends BaseProbe {
  readonly id = 'capacity';
  readonly cadence = 'slow' as const;
  readonly platformId: string;

  private readonly graphStore: GraphStore;
  private readonly execSource: CapacityExecSource | undefined;
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly growthWindowSeconds: number;

  /**
   * In-memory last-sample store for growth-rate computation.
   * Key: entity id. Value: last CapacitySample.
   */
  private readonly lastSamples = new Map<string, CapacitySample>();

  constructor(opts: CapacityProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.graphStore = opts.graphStore;
    this.execSource = opts.execSource;
    this.warnThreshold = opts.warnThreshold ?? 0.80;
    this.criticalThreshold = opts.criticalThreshold ?? 0.90;
    this.growthWindowSeconds = opts.growthWindowSeconds ?? 7 * 24 * 3600;
  }

  // -------------------------------------------------------------------------
  // scan
  // -------------------------------------------------------------------------

  /**
   * Enumerate all capacity-bearing entities from the graph, collect live
   * fill readings where possible, and emit observations for targets that
   * exceed thresholds or are growing toward full.
   *
   * Returns `[]` when the graph is empty or all targets degrade gracefully.
   */
  async scan(): Promise<Observation[]> {
    const entities = await this.enumerateCapacityEntities();
    const observations: Observation[] = [];
    const now = Date.now();

    for (const entity of entities) {
      try {
        const obs = await this.probeEntity(entity, now);
        observations.push(...obs);
      } catch {
        // Per-target failure: skip and continue (graceful degradation).
      }
    }

    return observations;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Collect all entities from the graph whose `kind` is one of the
   * recognised capacity-bearing kinds. Gracefully returns `[]` when the
   * graph file is absent or unreadable.
   */
  private async enumerateCapacityEntities(): Promise<Entity[]> {
    const all: Entity[] = [];
    for (const kind of CAPACITY_KINDS) {
      let found: Entity[];
      try {
        found = await this.graphStore.entitiesByKind(kind);
      } catch {
        // Graph read failure for this kind — skip and continue.
        continue;
      }
      all.push(...found);
    }
    return all;
  }

  /**
   * Probe one entity: collect live capacity, update sample history,
   * compute fill ratio and growth rate, emit observations.
   *
   * @param entity - The entity to probe.
   * @param now    - Current epoch milliseconds (for growth computation).
   * @returns Array of observations (may be empty if thresholds not exceeded).
   */
  private async probeEntity(entity: Entity, now: number): Promise<Observation[]> {
    const sample = await this.collectSample(entity, now);
    if (sample === null) return [];

    const { usedBytes, totalBytes, sampledAt } = sample;
    const fillRatio = usedBytes / totalBytes;

    // Compute growth rate from previous sample.
    const prev = this.lastSamples.get(entity.id);
    let fillRateBytesPerSecond: number | null = null;
    let secondsToFull: number | null = null;

    if (prev !== undefined) {
      const dtSeconds = (sampledAt - prev.sampledAt) / 1000;
      if (dtSeconds > 0) {
        const deltaUsed = usedBytes - prev.usedBytes;
        fillRateBytesPerSecond = deltaUsed / dtSeconds;
        const freeBytes = totalBytes - usedBytes;
        if (fillRateBytesPerSecond > 0 && freeBytes >= 0) {
          secondsToFull = freeBytes / fillRateBytesPerSecond;
        }
      }
    }

    // Store the new sample.
    this.lastSamples.set(entity.id, sample);

    const resource = `${entity.kind}/${entity.name}`;
    const usedPct = Math.round(fillRatio * 100);
    const observations: Observation[] = [];

    // -----------------------------------------------------------------------
    // 1. Critical threshold
    // -----------------------------------------------------------------------
    if (fillRatio >= this.criticalThreshold) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'capacity_critical',
          resource,
          severity: 'P0',
          details: {
            kind: entity.kind,
            entity_id: entity.id,
            used_bytes: usedBytes,
            total_bytes: totalBytes,
            used_pct: usedPct,
            threshold_pct: Math.round(this.criticalThreshold * 100),
            fill_rate_bytes_per_second: fillRateBytesPerSecond ?? null,
            days_to_full:
              secondsToFull !== null ? Math.round(secondsToFull / 86400) : null,
          },
        }),
      );
      return observations; // critical subsumes warn
    }

    // -----------------------------------------------------------------------
    // 2. Warn threshold
    // -----------------------------------------------------------------------
    if (fillRatio >= this.warnThreshold) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'capacity_warning',
          resource,
          severity: 'P1',
          details: {
            kind: entity.kind,
            entity_id: entity.id,
            used_bytes: usedBytes,
            total_bytes: totalBytes,
            used_pct: usedPct,
            threshold_pct: Math.round(this.warnThreshold * 100),
            fill_rate_bytes_per_second: fillRateBytesPerSecond ?? null,
            days_to_full:
              secondsToFull !== null ? Math.round(secondsToFull / 86400) : null,
          },
        }),
      );
      return observations;
    }

    // -----------------------------------------------------------------------
    // 3. Growth-rate projection (below warn threshold but trending toward full)
    // -----------------------------------------------------------------------
    if (
      secondsToFull !== null &&
      secondsToFull > 0 &&
      secondsToFull <= this.growthWindowSeconds
    ) {
      observations.push(
        this.makeObservation({
          platform: this.platformId,
          pattern: 'capacity_growth',
          resource,
          severity: 'P1',
          details: {
            kind: entity.kind,
            entity_id: entity.id,
            used_bytes: usedBytes,
            total_bytes: totalBytes,
            used_pct: usedPct,
            fill_rate_bytes_per_second: fillRateBytesPerSecond,
            seconds_to_full: Math.round(secondsToFull),
            days_to_full: Math.round(secondsToFull / 86400),
            growth_window_days: Math.round(this.growthWindowSeconds / 86400),
          },
        }),
      );
    }

    return observations;
  }

  /**
   * Collect a live capacity sample for the entity.
   *
   * Precedence:
   *   1. Live `df -PB1 <path>` for filesystem-bearing kinds when an exec
   *      source is available.
   *   2. Live `zpool list -Hp <name>` for `pool` kind when an exec source
   *      is available.
   *   3. Graph-attribute fallback (no exec source, or exec fails).
   *
   * @param entity    - Entity to sample.
   * @param sampledAt - Epoch ms for the sample timestamp.
   * @returns A `CapacitySample`, or `null` when no capacity data is
   *          available (the target should be skipped).
   */
  private async collectSample(
    entity: Entity,
    sampledAt: number,
  ): Promise<CapacitySample | null> {
    const kind = entity.kind as CapacityKind;

    // --- Live df for filesystem kinds ---
    if (
      this.execSource !== undefined &&
      (kind === 'storage-array' || kind === 'storage-disk' || kind === 'share')
    ) {
      const mountPath = dfMountPath(entity);
      if (mountPath !== null) {
        const result = await this.tryDf(mountPath);
        if (result !== null) {
          return { usedBytes: result.used, totalBytes: result.total, sampledAt };
        }
      }
    }

    // --- Live zpool list for pool kind ---
    if (this.execSource !== undefined && kind === 'pool') {
      const result = await this.tryZpoolList(entity.name);
      if (result !== null) {
        return { usedBytes: result.used, totalBytes: result.total, sampledAt };
      }
    }

    // --- Graph-attribute fallback ---
    const attrResult = readCapacityFromAttributes(entity);
    if (attrResult !== null) {
      return { usedBytes: attrResult.used, totalBytes: attrResult.total, sampledAt };
    }

    // No capacity data available for this entity.
    return null;
  }

  /**
   * Run `df -PB1 <path>` and parse the result.
   * Returns `null` on exec failure, non-zero exit, or parse failure.
   *
   * @param mountPath - Filesystem path to pass to `df`.
   */
  private async tryDf(mountPath: string): Promise<{ used: number; total: number } | null> {
    if (this.execSource === undefined) return null;
    let result: { stdout: string; exitCode?: number };
    try {
      result = await this.execSource.exec(`df -PB1 ${mountPath}`);
    } catch {
      return null;
    }
    if ((result.exitCode ?? 0) !== 0) return null;

    // df -P output: first line is header; data starts at line 2.
    const lines = result.stdout.split('\n').filter((l) => l.trim() !== '');
    // Filter out the header line and /proc pseudo-filesystems.
    const dataLines = lines.filter(
      (l) => !l.startsWith('Filesystem') && !l.startsWith('/proc'),
    );
    for (const line of dataLines.reverse()) {
      const parsed = parseDfLine(line);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  /**
   * Run `zpool list -Hp <name>` and parse the result.
   * Returns `null` on exec failure, non-zero exit, or parse failure.
   *
   * @param poolName - ZFS pool name.
   */
  private async tryZpoolList(
    poolName: string,
  ): Promise<{ used: number; total: number } | null> {
    if (this.execSource === undefined) return null;
    let result: { stdout: string; exitCode?: number };
    try {
      result = await this.execSource.exec(`zpool list -Hp ${poolName}`);
    } catch {
      return null;
    }
    if ((result.exitCode ?? 0) !== 0) return null;

    const lines = result.stdout.split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      const parsed = parseZpoolListLine(line);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  /**
   * Expose the in-memory sample store for testing.
   * Returns a copy of the current last-sample map.
   *
   * @internal
   */
  getSampleSnapshot(): Map<string, CapacitySample> {
    return new Map(this.lastSamples);
  }
}

// ---------------------------------------------------------------------------
// Re-export CapacityKind for tests that need it
// ---------------------------------------------------------------------------

export { isCapacityKind, CAPACITY_KINDS };
