/**
 * `UnifiProbe`: pulls recent UniFi events filtered for AP-lost-contact
 * via a `UnifiEventSource` (typically backed by a `UnifiConnection`).
 * Implements SPEC-002-1-03.
 *
 * The event source is injected so tests can supply a deterministic list
 * without exercising the HTTPS layer.
 */

import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

export interface UnifiEvent {
  key: string;
  ap_mac?: string;
  ap?: string;
  msg?: string;
  time?: number;
  [k: string]: unknown;
}

export interface UnifiEventSource {
  readonly platformId: string;
  /** Returns events for the given subsystem within the lookback window. */
  getEvents(opts: { subsystem: string; since: string }): Promise<UnifiEvent[]>;
}

export class UnifiProbe extends BaseProbe {
  readonly id = 'unifi';
  readonly cadence = 'medium' as const;

  constructor(private readonly source: UnifiEventSource) {
    super();
  }

  get platformId(): string {
    return this.source.platformId;
  }

  async scan(): Promise<Observation[]> {
    let events: UnifiEvent[];
    try {
      events = await this.source.getEvents({ subsystem: 'wlan', since: '15m' });
    } catch (err) {
      return [this.unreachable(err, 'unifi')];
    }

    return events
      .filter((e) => e.key === 'EVT_AP_LOST_CONTACT')
      .map((e) => {
        const mac = e.ap_mac ?? e.ap ?? 'unknown';
        const details: Record<string, unknown> = {};
        if (e.msg !== undefined) details['msg'] = e.msg;
        if (e.time !== undefined) details['time'] = e.time;
        return this.makeObservation({
          platform: this.platformId,
          pattern: 'unifi_ap_offline',
          resource: `ap/${mac}`,
          severity: 'P1',
          details,
        });
      });
  }
}
