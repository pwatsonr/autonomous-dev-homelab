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

  constructor(opts: ObservationPromoterOptions = {}) {
    this.bin = opts.autonomousDevBin ?? 'autonomous-dev';
    this.repo = opts.defaultRepo ?? 'homelab';
    this.execFile = opts.execFile ?? defaultExec;
    this.auditWriter = opts.auditWriter;
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
}
