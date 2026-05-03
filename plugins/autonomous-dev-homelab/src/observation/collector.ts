/**
 * `ObservationCollector`: schedules probes per cadence, deduplicates,
 * persists, and routes to the promoter. Implements SPEC-002-1-04.
 *
 * Scheduling: each probe gets its own `setInterval(...).unref()` keyed
 * off its declared `cadence`. A separate 24h timer drives retention
 * cleanup. `runProbe` is exposed publicly for the `observe scan` CLI.
 *
 * Errors inside one probe MUST NOT crash the collector loop — every
 * scan is wrapped so the next probe still runs.
 */

import { emitAudit, type AuditWriter } from '../audit/writer.js';
import { DedupCache } from './dedup.js';
import { ObservationStore } from './persistence.js';
import { ObservationPromoter } from './promoter.js';
import type { Observation, Probe } from './types.js';

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const CADENCE_MS: Record<Probe['cadence'], number> = Object.freeze({
  fast: 5 * 60_000,
  medium: 15 * 60_000,
  slow: ONE_HOUR_MS,
  daily: ONE_DAY_MS,
});

export interface ObservationCollectorOptions {
  probes: Probe[];
  dedup: DedupCache;
  store: ObservationStore;
  promoter: ObservationPromoter;
  auditWriter?: AuditWriter;
  /** Test seam: defaults to global setInterval. */
  setInterval?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Test seam: defaults to global clearInterval. */
  clearInterval?: (t: NodeJS.Timeout) => void;
  /** Per-scan logger; defaults to a no-op. Errors during scan flow here. */
  logger?: { warn: (msg: string, err: unknown) => void };
}

export interface RunProbeOptions {
  /** When true, skip persistence + promotion (used by `observe scan --dry-run`). */
  dryRun?: boolean;
}

export class ObservationCollector {
  private readonly probes: Probe[];
  private readonly dedup: DedupCache;
  private readonly store: ObservationStore;
  private readonly promoter: ObservationPromoter;
  private readonly auditWriter: AuditWriter | undefined;
  private readonly setIntervalFn: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (t: NodeJS.Timeout) => void;
  private readonly logger: { warn: (msg: string, err: unknown) => void };

  private readonly timers: NodeJS.Timeout[] = [];

  constructor(opts: ObservationCollectorOptions) {
    this.probes = opts.probes;
    this.dedup = opts.dedup;
    this.store = opts.store;
    this.promoter = opts.promoter;
    this.auditWriter = opts.auditWriter;
    this.setIntervalFn = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms).unref());
    this.clearIntervalFn = opts.clearInterval ?? ((t) => clearInterval(t));
    this.logger = opts.logger ?? { warn: (): void => undefined };
  }

  /**
   * Hydrate dedup from recent observations, then start per-probe and
   * cleanup timers. Idempotent: repeat calls are a no-op until `stop()`.
   */
  async start(now: number = Date.now()): Promise<void> {
    if (this.timers.length > 0) return;
    const recent = await this.store.list({ since: new Date(now - ONE_HOUR_MS) });
    this.dedup.hydrate(recent, now);
    for (const probe of this.probes) {
      const interval = CADENCE_MS[probe.cadence];
      const t = this.setIntervalFn(() => {
        void this.runProbe(probe).catch((err) =>
          this.logger.warn(`probe ${probe.id} scan errored`, err),
        );
      }, interval);
      this.timers.push(t);
    }
    this.timers.push(
      this.setIntervalFn(() => {
        void this.store.cleanup().catch((err) =>
          this.logger.warn('observation cleanup errored', err),
        );
      }, ONE_DAY_MS),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) this.clearIntervalFn(t);
    this.timers.length = 0;
  }

  /**
   * Run one probe immediately. Returns the observations that survived
   * dedup and were (unless dryRun) persisted + promoted.
   */
  async runProbe(probe: Probe, opts: RunProbeOptions = {}): Promise<Observation[]> {
    let scanned: Observation[];
    try {
      scanned = await probe.scan();
    } catch (err) {
      this.logger.warn(`probe ${probe.id} scan threw unexpectedly`, err);
      return [];
    }
    const fresh: Observation[] = [];
    for (const obs of scanned) {
      if (this.dedup.isDuplicate(obs)) {
        await emitAudit(
          this.auditWriter,
          'observation_dedup_suppressed',
          { observation_id: obs.id, pattern: obs.pattern, dedup_key: obs.dedup_key ?? null },
          { platform: obs.platform },
        );
        continue;
      }
      if (opts.dryRun === true) {
        fresh.push(obs);
        continue;
      }
      try {
        await this.store.save(obs);
        await emitAudit(
          this.auditWriter,
          'observation_created',
          { observation_id: obs.id, pattern: obs.pattern, severity: obs.severity },
          { platform: obs.platform },
        );
      } catch (err) {
        this.logger.warn(`failed to persist observation ${obs.id}`, err);
        continue;
      }
      try {
        await this.promoter.promote(obs);
      } catch (err) {
        this.logger.warn(`failed to promote observation ${obs.id}`, err);
        // Persistence already happened; surface the failure but keep the loop alive.
      }
      fresh.push(obs);
    }
    return fresh;
  }

  /** Run all probes, optionally filtered by inventory `platformId`. */
  async runAll(
    filter: { platformId?: string } = {},
    opts: RunProbeOptions = {},
  ): Promise<Observation[]> {
    const subset =
      filter.platformId !== undefined
        ? this.probes.filter((p) => p.platformId === filter.platformId)
        : this.probes;
    const out: Observation[] = [];
    for (const p of subset) {
      out.push(...(await this.runProbe(p, opts)));
    }
    return out;
  }

  /** Test seam: number of running timers. */
  timerCount(): number {
    return this.timers.length;
  }
}
