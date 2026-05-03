/**
 * `ObservationPromoter`: maps each observation to an autonomous-dev
 * intake `request_type` + `destructiveness` (via `FAULT_CATALOG`) and
 * submits it via `autonomous-dev request submit`. Implements
 * SPEC-002-1-04.
 *
 * Test seams:
 *   - `execFile` is injected so tests never spawn a real binary.
 *   - `auditWriter` is optional; bootstrap wires the shared writer.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emitAudit, type AuditWriter } from '../audit/writer.js';
import { FAULT_CATALOG } from './fault-catalog.js';
import type { Destructiveness, Observation, RequestType } from './types.js';
import type { ClockStore } from '../metrics/clock-store.js';
import { emitFPRate } from '../metrics/emitters.js';

const defaultExec = promisify(nodeExecFile);

export type ExecFileFn = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface ObservationPromoterOptions {
  /** Path or name of the autonomous-dev binary. Default `"autonomous-dev"`. */
  autonomousDevBin?: string;
  /** Repo passed via `--repo`. Default `"homelab"`. */
  defaultRepo?: string;
  /** Override for testing. */
  execFile?: ExecFileFn;
  /** Optional audit writer for `observation_promoted` entries. */
  auditWriter?: AuditWriter;
  /**
   * Optional clock store. When provided, `promote()` starts an `mttr`
   * clock keyed by `observation.id` after successful intake submission.
   * SPEC-002-3-03.
   */
  clockStore?: ClockStore;
  /**
   * Probe id label used for `homelab_fp_rate` emissions. Defaults to the
   * observation's `pattern` field at emission time.
   */
  probeIdFn?: (obs: Observation) => string;
}

export interface PromoteOptions {
  /** Override the catalog-derived request_type for this submission only. */
  overrideType?: RequestType;
}

export class ObservationPromoter {
  private readonly bin: string;
  private readonly repo: string;
  private readonly execFile: ExecFileFn;
  private readonly auditWriter: AuditWriter | undefined;
  private readonly clockStore: ClockStore | undefined;
  private readonly probeIdFn: (obs: Observation) => string;

  constructor(opts: ObservationPromoterOptions = {}) {
    this.bin = opts.autonomousDevBin ?? 'autonomous-dev';
    this.repo = opts.defaultRepo ?? 'homelab';
    this.execFile = opts.execFile ?? defaultExec;
    this.auditWriter = opts.auditWriter;
    this.clockStore = opts.clockStore;
    this.probeIdFn = opts.probeIdFn ?? ((obs): string => obs.pattern);
  }

  mapToRequestType(obs: Observation): RequestType {
    return FAULT_CATALOG[obs.pattern].default_request_type;
  }

  mapToDestructiveness(obs: Observation): Destructiveness {
    return FAULT_CATALOG[obs.pattern].destructiveness;
  }

  buildBugReport(obs: Observation): string {
    const lines: string[] = [
      `Pattern: ${obs.pattern} on ${obs.resource}`,
      `Platform: ${obs.platform}`,
      `Severity: ${obs.severity}`,
      `Discovered: ${obs.discovered_at}`,
    ];
    if (obs.details !== undefined) {
      lines.push(`Details: ${JSON.stringify(obs.details)}`);
    }
    return lines.join('\n');
  }

  async promote(obs: Observation, opts: PromoteOptions = {}): Promise<void> {
    const requestType = opts.overrideType ?? this.mapToRequestType(obs);
    const destructiveness = this.mapToDestructiveness(obs);
    const args = [
      'request',
      'submit',
      '--type',
      requestType,
      '--source',
      'production-intelligence',
      '--repo',
      this.repo,
      '--description',
      this.buildBugReport(obs),
      '--metadata',
      JSON.stringify({
        destructiveness,
        observation_id: obs.id,
        severity: obs.severity,
      }),
    ];
    await this.execFile(this.bin, args);
    // SPEC-002-3-03: start MTTR clock AFTER successful submission so
    // failures inside the intake CLI don't leave orphaned clocks.
    if (this.clockStore !== undefined) {
      try {
        await this.clockStore.start('mttr', obs.id, {
          platform: obs.platform,
          pattern: obs.pattern,
        });
      } catch {
        // dup or write failure — non-fatal for promotion semantics.
      }
    }
    await emitAudit(
      this.auditWriter,
      'observation_promoted',
      {
        observation_id: obs.id,
        pattern: obs.pattern,
        request_type: requestType,
        destructiveness,
        override: opts.overrideType !== undefined,
      },
      { platform: obs.platform },
    );
  }

  /**
   * Mark a previously-promoted observation as cancelled (false-positive).
   * Stops the MTTR clock without emitting MTTR (the observation never
   * resolved) and emits `homelab_fp_rate` with `isFalsePositive=true`.
   * SPEC-002-3-03.
   */
  async cancel(obs: Observation): Promise<void> {
    if (this.clockStore !== undefined) {
      try {
        await this.clockStore.stop(`mttr:${obs.id}`);
      } catch {
        // ignore
      }
    }
    await emitFPRate(this.probeIdFn(obs), true);
  }

  /**
   * Mark a previously-promoted observation as resolved (true-positive).
   * Stops the MTTR clock and emits both `homelab_mttr_seconds` (via
   * caller) AND `homelab_fp_rate` with `isFalsePositive=false`. The
   * caller is responsible for emitting MTTR — this method just shapes
   * the FP-rate accounting.
   */
  async resolved(obs: Observation): Promise<void> {
    await emitFPRate(this.probeIdFn(obs), false);
  }
}
