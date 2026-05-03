/**
 * `CertExpiryProbe`: inspects TLS endpoints via an injected
 * `CertFetcher` and emits `cert_expiry_imminent` observations for
 * certificates expiring within 7 days. Implements SPEC-002-1-03.
 *
 * The fetcher is injected so tests never make real `tls.connect`
 * calls. A production fetcher built on `node:tls` is intentionally NOT
 * shipped here — bootstrap code (out of plan scope) wires one in.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface CertEndpoint {
  host: string;
  port: number;
  sni?: string;
}

export interface CertInfo {
  valid_to: string;
  issuer: string;
}

export interface CertFetcher {
  fetch(host: string, port: number, sni?: string): Promise<CertInfo>;
}

const WARN_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export interface CertExpiryProbeOptions {
  platformId: string;
  endpoints: CertEndpoint[];
  fetcher: CertFetcher;
  /** Test seam; defaults to `() => Date.now()`. */
  now?: () => number;
}

export class CertExpiryProbe extends BaseProbe {
  readonly id = 'cert-expiry';
  readonly cadence = 'slow' as const;
  readonly platformId: string;

  private readonly endpoints: CertEndpoint[];
  private readonly fetcher: CertFetcher;
  private readonly now: () => number;

  constructor(opts: CertExpiryProbeOptions) {
    super();
    this.platformId = opts.platformId;
    this.endpoints = opts.endpoints;
    this.fetcher = opts.fetcher;
    this.now = opts.now ?? ((): number => Date.now());
  }

  async scan(): Promise<Observation[]> {
    const out: Observation[] = [];
    for (const ep of this.endpoints) {
      let info: CertInfo;
      try {
        info = await this.fetcher.fetch(ep.host, ep.port, ep.sni);
      } catch (err) {
        out.push(
          this.unreachable(err, 'cert-expiry', `cert/${ep.host}:${ep.port}`),
        );
        continue;
      }
      const expiresAt = Date.parse(info.valid_to);
      const days_until = Math.floor((expiresAt - this.now()) / MS_PER_DAY);
      if (days_until <= WARN_DAYS) {
        out.push(
          this.makeObservation({
            platform: this.platformId,
            pattern: 'cert_expiry_imminent',
            resource: `cert/${ep.host}:${ep.port}`,
            severity: 'P2',
            details: {
              issuer: info.issuer,
              valid_to: info.valid_to,
              days_until,
            },
          }),
        );
      }
    }
    return out;
  }
}
