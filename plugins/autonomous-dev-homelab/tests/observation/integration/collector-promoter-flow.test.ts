/**
 * SPEC-002-1-05 — Collector + Promoter + Dedup end-to-end (no external services).
 *
 * Wires the REAL `ObservationCollector`, `DedupCache`, `ObservationStore`,
 * and `ObservationPromoter` together with:
 *   - a fake `Probe` that emits a known list per call,
 *   - a mocked `execFile` so we observe submission shape without spawning anything,
 *   - a tmp-dir-backed store for on-disk verification.
 *
 * Verifies:
 *   1. First call → save + promote
 *   2. Second call within window → both suppressed (dedup)
 *   3. After advancing dedup state by >1h → fresh save + promote
 *   4. On-disk artifacts validate against `observation-v1.json` (ajv)
 *   5. execFile receives the exact args contract from SPEC-002-1-04
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import schema from '../../../schemas/observation-v1.json';
import { ObservationCollector } from '../../../src/observation/collector';
import { DedupCache } from '../../../src/observation/dedup';
import { ObservationStore } from '../../../src/observation/persistence';
import { ObservationPromoter } from '../../../src/observation/promoter';
import type { Observation, Probe } from '../../../src/observation/types';
import { mkTempDir, rmTempDir } from '../../helpers/temp-dir';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateObservation: ValidateFunction = ajv.compile(schema);

const FIXED_OBS_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_PLATFORM = 'k3s-01';
const FIXED_RESOURCE = 'Pod/web-7c';
const DEDUP_WINDOW_MS = 3_600_000;

function buildObservation(now: number, idOverride?: string): Observation {
  return {
    id: idOverride ?? FIXED_OBS_ID,
    platform: FIXED_PLATFORM,
    pattern: 'oom_kill',
    resource: FIXED_RESOURCE,
    severity: 'P1',
    discovered_at: new Date(now).toISOString(),
    details: { count: 1, message: 'killed' },
    dedup_key: `${FIXED_PLATFORM}:oom_kill:${FIXED_RESOURCE}`,
  };
}

function makeFakeProbe(emit: () => Observation[]): Probe {
  return {
    id: 'fake-k8s',
    platformId: FIXED_PLATFORM,
    cadence: 'fast',
    scan: jest.fn(async () => emit()),
  };
}

describe('Collector + Promoter + Dedup integration (in-process)', () => {
  let dataDir: string;
  let store: ObservationStore;

  beforeEach(async () => {
    dataDir = await mkTempDir('obs-flow-');
    store = new ObservationStore(dataDir);
  });

  afterEach(async () => {
    await rmTempDir(dataDir);
  });

  test('1st call saves + promotes; 2nd call within window is fully suppressed; window expiry re-fires', async () => {
    const t0 = Date.UTC(2026, 4, 1, 12, 0, 0);
    const obsRound1 = buildObservation(t0);

    // Emit logically the same observation each scan (same dedup_key) but
    // with fresh ids so we can verify file-count behavior precisely.
    let scanCount = 0;
    const emissions: Observation[] = [
      obsRound1,
      // Round 2 — same dedup key, different id → MUST be suppressed.
      buildObservation(t0 + 60_000, '22222222-2222-4222-8222-222222222222'),
      // Round 3 — same dedup key after window expiry → must fire again.
      buildObservation(t0 + DEDUP_WINDOW_MS + 1, '33333333-3333-4333-8333-333333333333'),
    ];
    const probe = makeFakeProbe(() => {
      const next = emissions[scanCount];
      scanCount += 1;
      return next === undefined ? [] : [next];
    });

    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const promoter = new ObservationPromoter({
      autonomousDevBin: 'fake-autonomous-dev',
      defaultRepo: 'homelab',
      execFile,
    });

    // Drive a controllable "now" so we can advance past the dedup window
    // without waiting on real time. The DedupCache exposes `now` via
    // `isDuplicate(obs, now)`, so we pass a fresh DedupCache and stamp
    // its internal map directly between rounds — but we'd rather not
    // poke internals. Instead we use Date.now mocking, which the cache
    // and collector both consume by default.
    const realDateNow = Date.now;
    let mockedNow = t0;
    Date.now = (): number => mockedNow;

    try {
      const collector = new ObservationCollector({
        probes: [probe],
        dedup: new DedupCache(DEDUP_WINDOW_MS),
        store,
        promoter,
      });

      // Round 1: persist + promote.
      const r1 = await collector.runProbe(probe);
      expect(r1).toHaveLength(1);
      expect(execFile).toHaveBeenCalledTimes(1);

      // Round 2: same dedup key, still inside window → no-op.
      mockedNow = t0 + 60_000;
      const r2 = await collector.runProbe(probe);
      expect(r2).toEqual([]);
      expect(execFile).toHaveBeenCalledTimes(1);

      // Round 3: jump past the window → fires again.
      mockedNow = t0 + DEDUP_WINDOW_MS + 1;
      const r3 = await collector.runProbe(probe);
      expect(r3).toHaveLength(1);
      expect(execFile).toHaveBeenCalledTimes(2);

      // On-disk: only the two surviving observations were persisted.
      const obsDir = path.join(dataDir, 'observations');
      const files = (await fs.readdir(obsDir)).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(2);

      // Each persisted file is schema-valid.
      for (const f of files) {
        const raw = await fs.readFile(path.join(obsDir, f), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const ok = validateObservation(parsed);
        if (!ok) {
          // eslint-disable-next-line no-console
          console.error('schema errors:', validateObservation.errors);
        }
        expect(ok).toBe(true);
      }
    } finally {
      Date.now = realDateNow;
    }
  });

  test('execFile receives the exact request-submit arg vector for the test observation', async () => {
    const t0 = Date.UTC(2026, 4, 1, 12, 0, 0);
    const o = buildObservation(t0);
    const probe = makeFakeProbe(() => [o]);
    const execFile = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const promoter = new ObservationPromoter({
      autonomousDevBin: 'fake-autonomous-dev',
      defaultRepo: 'homelab',
      execFile,
    });
    const collector = new ObservationCollector({
      probes: [probe],
      dedup: new DedupCache(DEDUP_WINDOW_MS),
      store,
      promoter,
    });

    await collector.runProbe(probe);

    expect(execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = execFile.mock.calls[0]!;
    expect(bin).toBe('fake-autonomous-dev');
    expect(args).toEqual([
      'request',
      'submit',
      '--type',
      'bug',
      '--source',
      'production-intelligence',
      '--repo',
      'homelab',
      '--description',
      expect.stringContaining('oom_kill'),
      '--metadata',
      expect.stringContaining(`"observation_id":"${FIXED_OBS_ID}"`),
    ]);
    // Last arg parses as JSON with the expected shape.
    const metadata = JSON.parse((args as string[])[(args as string[]).length - 1]!) as Record<
      string,
      unknown
    >;
    expect(metadata).toEqual({
      destructiveness: 'persistent-modifying',
      observation_id: FIXED_OBS_ID,
      severity: 'P1',
    });
  });
});
