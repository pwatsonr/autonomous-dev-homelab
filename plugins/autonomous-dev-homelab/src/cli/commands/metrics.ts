/**
 * `homelab metrics show` command per SPEC-002-3-03.
 *
 * Reads from the local FP-counter cache + the configured TDD-007 client
 * (when present). Falls back to read-only mode when the pipeline is
 * unreachable.
 */

import { Command } from 'commander';
import { readFPCounters } from '../../metrics/emitters.js';
import { ClockStore } from '../../metrics/clock-store.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  printTable,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

export type MetricName = 'mttr' | 'fp_rate' | 'gate_latency' | 'bypass_attempts';

export interface MetricsCommandDeps {
  streams?: OutputStreams;
  /** Override for tests. */
  clockStore?: ClockStore;
  /** Override for tests / production. */
  pipelineQuery?: PipelineQuery;
}

export interface PipelineQuery {
  /** Returns metric data; null when pipeline is unreachable. */
  query(metric: MetricName, sinceMs: number): Promise<MetricSnapshot | null>;
}

export interface MetricSnapshot {
  /** Headline numeric value (median, current, etc.). */
  value: number;
  /** 30-day trend (sparkline-friendly, ascending time). */
  trend: number[];
  /** Free-form breakdown rows for `--metric` views. */
  breakdown?: Record<string, string>[];
}

export interface MetricsCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

const VALID_METRICS = new Set<MetricName>(['mttr', 'fp_rate', 'gate_latency', 'bypass_attempts']);

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

function parseSince(value: string): number | null {
  const m = DURATION_RE.exec(value);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '0', 10);
  const unit = m[2];
  const factor =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

export function buildMetricsCommand(deps: MetricsCommandDeps = {}): MetricsCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const clockStore = deps.clockStore ?? new ClockStore();
  let lastExit = EXIT_OK;

  const cmd = new Command('metrics').description(
    'Inspect homelab safety + observability metrics.',
  );

  cmd
    .command('show')
    .description('Print the four homelab metrics (MTTR, FP-rate, gate-latency, bypass-attempts).')
    .option('--metric <name>', 'restrict to one metric: mttr|fp_rate|gate_latency|bypass_attempts')
    .option('--json', 'emit JSON instead of a human-readable table')
    .option('--since <duration>', 'window length (e.g. 1h, 24h, 7d, 30d)', '30d')
    .action(async (opts: { metric?: string; json?: boolean; since?: string }) => {
      const sinceMs = parseSince(opts.since ?? '30d');
      if (sinceMs === null) {
        printError(`unknown --since value: ${opts.since}`, streams);
        lastExit = EXIT_USAGE;
        return;
      }
      let metric: MetricName | undefined;
      if (opts.metric !== undefined) {
        if (!VALID_METRICS.has(opts.metric as MetricName)) {
          printError(`unknown --metric value: ${opts.metric}`, streams);
          lastExit = EXIT_USAGE;
          return;
        }
        metric = opts.metric as MetricName;
      }

      const fpCounters = await readFPCounters().catch(() => ({ probes: {} }));
      const orphanedClocks = await clockStore.purgeStale(0).catch(() => 0);

      if (opts.json === true) {
        const payload: Record<string, unknown> = {
          since: opts.since ?? '30d',
          orphaned_clocks: orphanedClocks,
          fp_counters: fpCounters,
        };
        if (metric !== undefined && deps.pipelineQuery !== undefined) {
          payload['snapshot'] = await deps.pipelineQuery.query(metric, sinceMs);
        }
        printJson(payload, streams);
        lastExit = EXIT_OK;
        return;
      }

      if (metric === undefined) {
        const rows: Record<string, string>[] = [
          { metric: 'homelab_mttr_seconds', current: 'see --metric mttr', trend: '' },
          { metric: 'homelab_fp_rate', current: summariseFp(fpCounters), trend: '' },
          { metric: 'homelab_gate_latency_seconds', current: 'see --metric gate_latency', trend: '' },
          { metric: 'homelab_bypass_attempts_total', current: 'see --metric bypass_attempts', trend: '' },
        ];
        printTable(rows, ['metric', 'current', 'trend'], streams);
        if (orphanedClocks > 0) {
          streams.stdout(`orphaned_clocks: ${orphanedClocks}\n`);
        }
        lastExit = EXIT_OK;
        return;
      }

      // metric-specific view.
      if (deps.pipelineQuery === undefined) {
        streams.stdout('(no metrics pipeline configured; showing local fallback)\n');
      }
      const snap =
        deps.pipelineQuery !== undefined ? await deps.pipelineQuery.query(metric, sinceMs) : null;
      if (snap === null) {
        if (metric === 'fp_rate') {
          const rows: Record<string, string>[] = Object.entries(fpCounters.probes).map(
            ([probe, c]) => ({
              probe,
              fp_total: String(c.fp_total),
              obs_total: String(c.obs_total),
              ratio: c.obs_total === 0 ? '0' : (c.fp_total / c.obs_total).toFixed(3),
            }),
          );
          printTable(rows, ['probe', 'fp_total', 'obs_total', 'ratio'], streams);
          if (orphanedClocks > 0) streams.stdout(`orphaned_clocks: ${orphanedClocks}\n`);
          lastExit = EXIT_OK;
          return;
        }
        printError('metrics pipeline unreachable; no local fallback for this metric', streams);
        lastExit = EXIT_USAGE;
        return;
      }
      const rows = snap.breakdown ?? [{ value: String(snap.value) }];
      printTable(rows, Object.keys(rows[0] ?? { value: '' }), streams);
      if (orphanedClocks > 0) streams.stdout(`orphaned_clocks: ${orphanedClocks}\n`);
      lastExit = EXIT_OK;
    });

  return {
    command: cmd,
    lastExitCode: (): number => lastExit,
  };
}

function summariseFp(counters: { probes: Record<string, { fp_total: number; obs_total: number }> }): string {
  const entries = Object.entries(counters.probes);
  if (entries.length === 0) return '0/0';
  let fpSum = 0;
  let obsSum = 0;
  for (const [, c] of entries) {
    fpSum += c.fp_total;
    obsSum += c.obs_total;
  }
  return `${fpSum}/${obsSum}`;
}
