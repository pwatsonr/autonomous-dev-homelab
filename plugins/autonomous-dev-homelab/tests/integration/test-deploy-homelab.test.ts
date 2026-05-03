/**
 * Integration: deploy-homelab fault → fix → metric chain. SPEC-002-3-04.
 *
 * Wires the homelab-side components that this plugin owns (clock store,
 * metric sink, deploy backend) into a single in-process flow. The "fault
 * detection → expert agent" portion of the chain crosses the
 * autonomous-dev intake boundary (PLAN-002-1 / PLAN-002-2) which the
 * homelab plugin cannot import here, so those scenarios are marked
 * `it.skip` with a comment explaining the gating dependency.
 *
 * The non-skipped flow proves:
 *   1. A deploy through `ProxmoxHomelabBackend` (mocked Proxmox connection)
 *      produces a signed `DeploymentRecord`.
 *   2. The clock-store records start/stop for both `mttr` and `gate-latency`
 *      in the correct order (mttr clock starts BEFORE gate-latency clock;
 *      gate-latency stop fires BEFORE mttr stop).
 *   3. Metric emission lands EXACTLY 1× MTTR + 1× gate-latency, ZERO
 *      `homelab_fp_rate`, ZERO `homelab_bypass_attempts_total` events on
 *      the in-memory metric sink.
 *   4. `clockStore.purgeStale(0)` returns 0 — no orphaned clocks remain.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureHmacSecret } from '../helpers/hmac-secret';
import { mockProxmoxConnection } from '../helpers/mock-connections';

import { ProxmoxHomelabBackend } from '../../src/deploy/backends/proxmox';
import { verifyDeploymentRecord } from '../../src/deploy/sign-record';
import { ClockStore } from '../../src/metrics/clock-store';
import {
  configureMetrics,
  emitGateLatency,
  emitMTTR,
  setFPCountersPath,
} from '../../src/metrics/emitters';
import type { MetricEvent, MetricSink } from '../../src/metrics/types';

interface RecordingSink extends MetricSink {
  events: MetricEvent[];
}

function makeRecordingSink(): RecordingSink {
  const events: MetricEvent[] = [];
  return {
    events,
    emit(event: MetricEvent) {
      events.push(event);
    },
  };
}

let tempDir: string;
let sink: RecordingSink;

beforeAll(() => {
  ensureHmacSecret();
});

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integ-deploy-homelab-'));
  process.env['HOMELAB_DATA_DIR'] = tempDir;
  setFPCountersPath(path.join(tempDir, 'fp-counters.json'));
  sink = makeRecordingSink();
  configureMetrics(sink);
});

afterEach(async () => {
  configureMetrics(null);
  setFPCountersPath(null);
  delete process.env['HOMELAB_DATA_DIR'];
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('integration: deploy-homelab fault → fix → metric', () => {
  it('emits exactly one MTTR + one gate-latency metric and leaves no orphan clocks', async () => {
    // -- Arrange: backend with mocked Proxmox connection --------------------
    const conn = mockProxmoxConnection({
      patterns: [
        { match: 'pct create', result: { stdout: 'ok', stderr: '', exitCode: 0 } },
        { match: 'pct start', result: { stdout: '', stderr: '', exitCode: 0 } },
        { match: 'pct status', result: { stdout: 'status: running', stderr: '', exitCode: 0 } },
        { match: 'pct exec', result: { stdout: '[]', stderr: '', exitCode: 0 } },
      ],
      fallback: { stdout: '', stderr: '', exitCode: 0 },
    });
    let nowVal = 1700000000000;
    const tick = (ms: number): void => {
      nowVal += ms;
    };
    const backend = new ProxmoxHomelabBackend({
      getConnection: async () => conn,
      sleep: async () => undefined,
      now: () => nowVal,
      generateId: () => 'integ-rec',
    });
    const clockStore = new ClockStore({ dataDir: tempDir, now: () => nowVal });

    // -- Act: simulate the fault → gate → fix → metric ordering -------------
    // Step 1: an "observation" raised → MTTR clock starts.
    const observationId = 'oom-obs-100';
    await clockStore.start('mttr', observationId, {
      platform: 'homelab-proxmox',
      pattern: 'oom-kill',
    });
    tick(50); // operator sees the page

    // Step 2: a fix action enters the gate → gate-latency clock starts.
    const actionId = 'act-100';
    await clockStore.start('gate-latency', actionId, {
      action_type: 'bug',
      destructiveness: 'reversible',
    });
    tick(120); // typed-confirm completes

    // Step 3: gate approves → gate-latency stops + emits.
    const gateStop = await clockStore.stop(`gate-latency:${actionId}`);
    expect(gateStop).not.toBeNull();
    emitGateLatency('bug', 'reversible', gateStop?.durationMs ?? 0);

    // Step 4: fix runs the deploy → signed record produced.
    const artifact = await backend.build({
      requestId: 'req-1',
      envName: 'prod',
      repoPath: '/repo',
      commitSha: 'integ-sha',
      params: {
        node_id: 'pve-01',
        workload_kind: 'lxc',
        vmid: 100,
        image_uri: 'local:vztmpl/debian-12.tar.zst',
        storage_pool: 'local-lvm',
        hostname: 'web1',
      },
    });
    const record = await backend.deploy(artifact, 'prod', {
      node_id: 'pve-01',
      workload_kind: 'lxc',
      vmid: 100,
      image_uri: 'local:vztmpl/debian-12.tar.zst',
      storage_pool: 'local-lvm',
      hostname: 'web1',
    });
    expect(verifyDeploymentRecord(record)).toBe(true);

    tick(800); // post-deploy settle
    // Step 5: observation resolved → MTTR stops + emits.
    const mttrStop = await clockStore.stop(`mttr:${observationId}`);
    expect(mttrStop).not.toBeNull();
    emitMTTR('homelab-proxmox', 'oom-kill', mttrStop?.durationMs ?? 0);

    // -- Assert: metric counts -----------------------------------------------
    const mttrEvents = sink.events.filter((e) => e.name === 'homelab_mttr_seconds');
    const gateEvents = sink.events.filter((e) => e.name === 'homelab_gate_latency_seconds');
    const fpEvents = sink.events.filter((e) => e.name === 'homelab_fp_rate');
    const bypassEvents = sink.events.filter(
      (e) => e.name === 'homelab_bypass_attempts_total',
    );
    expect(mttrEvents).toHaveLength(1);
    expect(gateEvents).toHaveLength(1);
    expect(fpEvents).toHaveLength(0);
    expect(bypassEvents).toHaveLength(0);

    // Labels are correct.
    expect(mttrEvents[0]?.labels).toEqual({
      platform: 'homelab-proxmox',
      pattern: 'oom-kill',
    });
    expect(gateEvents[0]?.labels).toEqual({
      action_type: 'bug',
      destructiveness: 'reversible',
    });

    // Gate emit fired BEFORE MTTR emit (sink ordering preserved).
    const gateIdx = sink.events.findIndex((e) => e.name === 'homelab_gate_latency_seconds');
    const mttrIdx = sink.events.findIndex((e) => e.name === 'homelab_mttr_seconds');
    expect(gateIdx).toBeLessThan(mttrIdx);

    // No orphan clocks.
    expect(await clockStore.purgeStale(0)).toBe(0);
  });

  it.skip(
    'observation → promotion → expert fix-plan → gate → execute → metric (full chain)',
    () => {
      // SKIPPED: this scenario depends on autonomous-dev intake binary
      // (PLAN-002-1 promoter shells out via execFile) and the
      // proxmox-expert specialist agent (PLAN-002-2). Both cross the
      // homelab/autonomous-dev package boundary; covering them here would
      // require a fixture binary on $PATH plus an LLM stub. The
      // operator-driven smoke flow in PLAN-002-3's testing strategy covers
      // this end-to-end with a real intake daemon.
    },
  );
});
