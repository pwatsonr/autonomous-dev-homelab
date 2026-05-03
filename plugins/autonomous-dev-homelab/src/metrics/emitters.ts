/**
 * Metric emitters per SPEC-002-3-03.
 *
 * All four emitters are synchronous-fire-and-forget: failures inside the
 * sink are caught and logged at WARN; the function never propagates.
 * `emitFPRate` aggregates per-probe counters in a JSON file (HMAC-signed)
 * because the rolling 7d ratio needs both numerator + denominator across
 * daemon restarts — a feature the metrics pipeline does not provide.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../util/atomic-write.js';
import { signPayload, verifyPayload } from '../safety/hmac.js';
import type {
  ActionType,
  BypassReason,
  Destructiveness,
  MetricEvent,
  MetricSink,
} from './types.js';

let activeSink: MetricSink | null = null;
let warnLogger: (msg: string, ctx?: Record<string, unknown>) => void = (msg) => {
  process.stderr.write(`WARN: ${msg}\n`);
};

/**
 * Wires the metric sink. Production wiring calls this once at daemon
 * startup with the TDD-007 client; tests reset between cases.
 */
export function configureMetrics(sink: MetricSink | null, options: { warn?: typeof warnLogger } = {}): void {
  activeSink = sink;
  if (options.warn) warnLogger = options.warn;
}

function safeEmit(event: MetricEvent): void {
  if (activeSink === null) return;
  try {
    activeSink.emit(event);
  } catch (err) {
    warnLogger(`metrics emit failed: ${(err as Error).message}`, {
      metric: event.name,
    });
  }
}

export function emitMTTR(platform: string, pattern: string, durationMs: number): void {
  safeEmit({
    name: 'homelab_mttr_seconds',
    kind: 'histogram',
    value: durationMs / 1000,
    labels: { platform, pattern },
  });
}

export function emitGateLatency(
  actionType: ActionType,
  destructiveness: Destructiveness,
  durationMs: number,
): void {
  safeEmit({
    name: 'homelab_gate_latency_seconds',
    kind: 'histogram',
    value: durationMs / 1000,
    labels: { action_type: actionType, destructiveness },
  });
}

export function emitBypassAttempt(operatorId: string, reason: BypassReason): void {
  safeEmit({
    name: 'homelab_bypass_attempts_total',
    kind: 'counter',
    value: 1,
    labels: { operator: operatorId, reason },
  });
}

// -- emitFPRate: persisted counters + rolling ratio -----------------------

interface FPCounters {
  /** Per-probe { fp_total, obs_total, last_updated_iso }. */
  probes: Record<string, { fp_total: number; obs_total: number; last_updated_iso: string }>;
}

let countersPathOverride: string | null = null;

export function setFPCountersPath(p: string | null): void {
  countersPathOverride = p;
}

function defaultCountersPath(): string {
  const fromEnv = process.env['HOMELAB_DATA_DIR'] ?? process.env['CLAUDE_PLUGIN_DATA'];
  const dir = fromEnv !== undefined && fromEnv !== '' ? fromEnv : path.resolve(process.cwd(), '.homelab-data');
  return path.join(dir, 'metrics-fp-counters.json');
}

async function loadCounters(): Promise<FPCounters> {
  const filePath = countersPathOverride ?? defaultCountersPath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { probes: {} };
    throw err;
  }
  const signed = JSON.parse(raw) as { payload: FPCounters; hmac: string };
  if (!verifyPayload(signed)) {
    warnLogger('fp counters HMAC mismatch — resetting');
    return { probes: {} };
  }
  return signed.payload;
}

async function saveCounters(counters: FPCounters): Promise<void> {
  const filePath = countersPathOverride ?? defaultCountersPath();
  const signed = signPayload(counters);
  await atomicWriteFile(filePath, JSON.stringify(signed));
}

/**
 * Increment the per-probe counters and emit `homelab_fp_rate` with the
 * current ratio. `isFalsePositive=true` increments both fp_total and
 * obs_total; `false` increments only obs_total.
 */
export async function emitFPRate(probe: string, isFalsePositive: boolean): Promise<void> {
  let counters: FPCounters;
  try {
    counters = await loadCounters();
  } catch (err) {
    warnLogger(`fp counters load failed: ${(err as Error).message}`, { probe });
    return;
  }
  const cur = counters.probes[probe] ?? {
    fp_total: 0,
    obs_total: 0,
    last_updated_iso: new Date(0).toISOString(),
  };
  cur.obs_total += 1;
  if (isFalsePositive) cur.fp_total += 1;
  cur.last_updated_iso = new Date().toISOString();
  counters.probes[probe] = cur;
  try {
    await saveCounters(counters);
  } catch (err) {
    warnLogger(`fp counters save failed: ${(err as Error).message}`, { probe });
  }
  const ratio = cur.obs_total === 0 ? 0 : cur.fp_total / cur.obs_total;
  safeEmit({
    name: 'homelab_fp_rate',
    kind: 'gauge',
    value: ratio,
    labels: { probe },
  });
}

/** Test seam: read current persisted counters. */
export async function readFPCounters(): Promise<FPCounters> {
  return loadCounters();
}
