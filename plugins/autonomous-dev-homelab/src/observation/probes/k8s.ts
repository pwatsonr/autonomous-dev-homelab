/**
 * `K8sProbe`: queries `kubectl get events --field-selector type=Warning`
 * via a `K8sConnection` (PLAN-001-2) and emits `crash_loop` /
 * `oom_kill` observations. Implements SPEC-002-1-02.
 *
 * Connection errors are converted to a single `daemon_heartbeat_stale`
 * sentinel observation (no throw) so the collector loop survives
 * transient outages.
 */

import type { K8sConnection } from '../../connection/k8s.js';
import type { Observation } from '../types.js';
import { BaseProbe } from './base.js';

interface KubectlEvent {
  reason: string;
  count?: number;
  message?: string;
  involvedObject: { kind: string; name: string };
}

const KUBECTL_EVENTS_CMD =
  'kubectl get events --field-selector type=Warning -A -o json';

export class K8sProbe extends BaseProbe {
  readonly id = 'k8s';
  readonly cadence = 'fast' as const;

  constructor(private readonly conn: K8sConnection) {
    super();
  }

  get platformId(): string {
    return this.conn.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.conn.exec(KUBECTL_EVENTS_CMD);
    } catch (err) {
      return [this.unreachable(err, 'k8s', `cluster/${this.platformId}`)];
    }

    let parsed: { items?: KubectlEvent[] };
    try {
      parsed = JSON.parse(raw.stdout) as { items?: KubectlEvent[] };
    } catch (err) {
      return [this.unreachable(err, 'k8s', `cluster/${this.platformId}`)];
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items
      .filter((e) => e.reason === 'BackOff' || e.reason === 'OOMKilled')
      .map((e) =>
        this.makeObservation({
          platform: this.platformId,
          pattern: e.reason === 'OOMKilled' ? 'oom_kill' : 'crash_loop',
          resource: `${e.involvedObject.kind}/${e.involvedObject.name}`,
          severity: 'P1',
          details: { count: e.count ?? 1, message: e.message ?? '' },
        }),
      );
  }
}
