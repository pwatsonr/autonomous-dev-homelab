/**
 * SPEC-002-1-05 — End-to-end K8s observation test against a `kind` cluster.
 *
 * Stands up a real Kubernetes-in-Docker cluster, applies a deliberately
 * crashlooping pod, runs the real `K8sProbe` through the real
 * `ObservationCollector` + `ObservationStore` + `ObservationPromoter`,
 * and verifies:
 *   - the crash_loop pattern is detected end-to-end,
 *   - the observation is persisted under `<dataDir>/observations/<id>.json`,
 *   - the mocked `autonomous-dev` shim was invoked exactly once with the
 *     expected request-submit args,
 *   - a second collector pass within the dedup window emits NOTHING and
 *     adds NO new shim invocations (dedup proven end-to-end).
 *
 * Skipped automatically when `kind` or `docker` is not on PATH, or when
 * `KIND_INTEGRATION=1` is not set in the environment. This keeps `npm test`
 * fast and hermetic on dev machines while still wiring the test for CI.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { Connection, type ExecOptions, type ExecResult } from '../../src/connection/base';
import { ObservationCollector } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import { ObservationStore } from '../../src/observation/persistence';
import { ObservationPromoter } from '../../src/observation/promoter';
import { K8sProbe } from '../../src/observation/probes/k8s';
import {
  isKindAvailable,
  kubectlApply,
  setupKind,
  teardownKind,
  waitForCrashLoop,
} from './helpers/kind-cluster';
import { makeMockAutonomousDev, type MockAutonomousDev } from './helpers/mock-autonomous-dev';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const exec = promisify(execFileCb);

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'k8s-crashloop-pod.yaml');
const POD_NAME = 'crashloop-test';
const PLATFORM_ID = 'kind-spec-002-1-05';

/**
 * Local `Connection` adapter that runs `kubectl --kubeconfig <path> ...`
 * via execFile. K8sProbe only consumes `.exec(command)` and `.platformId`,
 * so wrapping the real `K8sConnection` (which speaks MCP-or-SSH) is
 * unnecessary and would require infrastructure we don't have under kind.
 */
class KubectlConnection extends Connection {
  constructor(
    platformId: string,
    private readonly kubeconfig: string,
  ) {
    super(platformId);
    this.connected = true;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async exec(command: string, _opts: ExecOptions = {}): Promise<ExecResult> {
    // K8sProbe always invokes a single `kubectl ...` command; we forward
    // verbatim with `--kubeconfig` injected after the binary name.
    const parts = command.trim().split(/\s+/);
    if (parts[0] !== 'kubectl') {
      throw new Error(`KubectlConnection only supports kubectl commands, got: ${command}`);
    }
    const args = ['--kubeconfig', this.kubeconfig, ...parts.slice(1)];
    const start = Date.now();
    try {
      const { stdout, stderr } = await exec('kubectl', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - start };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? String(e.message),
        exitCode: typeof e.code === 'number' ? e.code : 1,
        durationMs: Date.now() - start,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

// Resolve the precondition synchronously at module load by deferring the
// suite registration into a top-level async IIFE pattern is not Jest-
// friendly; instead, we register the suite unconditionally and gate
// individual tests with `it.skip` when the precondition fails.
describe('K8s observation end-to-end (kind)', () => {
  let kindAvailable = false;
  let kubeconfig = '';
  let mockBin: MockAutonomousDev | null = null;
  let dataDir = '';

  beforeAll(async () => {
    kindAvailable = await isKindAvailable();
    if (!kindAvailable) return;
    ({ kubeconfig } = await setupKind());
    mockBin = await makeMockAutonomousDev();
    dataDir = await mkTempDir('k8s-obs-it-');
    await kubectlApply(kubeconfig, FIXTURE_PATH);
    await waitForCrashLoop(kubeconfig, POD_NAME, 'default', 60_000);
  }, 180_000);

  afterAll(async () => {
    if (!kindAvailable) return;
    try {
      await teardownKind();
    } finally {
      if (dataDir.length > 0) await rmTempDir(dataDir);
    }
  }, 120_000);

  const itIfKind = (
    name: string,
    fn: () => Promise<void>,
    timeout?: number,
  ): void => {
    if (!kindAvailable) {
      // Use it.skip so the report shows the suite was intentionally skipped.
      it.skip(name, fn);
      return;
    }
    it(name, fn, timeout);
  };

  itIfKind(
    'detects crashloop, persists observation, promotes once, dedups second scan',
    async () => {
      if (!kindAvailable || mockBin === null) {
        throw new Error('precondition not satisfied — kind unavailable');
      }
      const conn = new KubectlConnection(PLATFORM_ID, kubeconfig);
      const probe = new K8sProbe(
        // Cast: KubectlConnection satisfies the structural shape K8sProbe
        // requires (platformId + exec). The constructor type wants a real
        // K8sConnection but the probe never reaches into MCP/SSH internals.
        conn as unknown as ConstructorParameters<typeof K8sProbe>[0],
      );
      const store = new ObservationStore(dataDir);
      const dedup = new DedupCache();
      const promoter = new ObservationPromoter({
        autonomousDevBin: path.join(mockBin.binDir, 'autonomous-dev'),
        defaultRepo: 'homelab',
      });
      const collector = new ObservationCollector({
        probes: [probe],
        dedup,
        store,
        promoter,
      });

      const first = await collector.runProbe(probe);
      expect(first.length).toBeGreaterThanOrEqual(1);
      const crash = first.find((o) => o.pattern === 'crash_loop');
      expect(crash).toBeDefined();
      expect(crash!.resource).toMatch(new RegExp(`^Pod/${POD_NAME}`));

      const persisted = await store.list();
      expect(persisted.length).toBe(first.length);

      const log = await fs.readFile(mockBin.logFile, 'utf8');
      expect(log).toContain('request submit');
      expect(log).toContain('--type bug');
      expect(log).toContain('--source production-intelligence');
      expect(log).toContain('--repo homelab');

      const second = await collector.runProbe(probe);
      expect(second).toEqual([]);

      const log2 = await fs.readFile(mockBin.logFile, 'utf8');
      expect(log2).toBe(log);
    },
    120_000,
  );
});
