/**
 * Tests for the autofix CLI subsystem (issue #13).
 *
 * Covers:
 *   (a) propose: reads a crash_loop observation and produces a real
 *       Action-bearing proposal (correct host/service/command, correct
 *       destructiveness — NOT the old hardcoded stub).
 *   (b) dry-run: reflects the real destructiveness classification.
 *   (c) apply: executes the remediation via a MOCK connection when
 *       confirmation is given; does NOT execute (throws/returns non-zero,
 *       emits gate.denied) when confirmation is refused.
 *   (d) unsupported pattern yields no-op, not a bogus mutation.
 *
 * Safety model: gate.ts, typed-confirm, and delay are mocked so no real
 * stdin blocking, no real filesystem scheduling, and no real connections
 * are used. The mock connection's exec() is a jest.fn() we can assert on.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runAutofixPropose,
  runAutofixDryRun,
  runAutofixApply,
  buildAutofixCommand,
  type AutofixDeps,
  type Proposal,
  EXIT_OK,
  EXIT_FAIL,
} from '../../src/cli/commands/autofix';
import { ObservationStore } from '../../src/observation/persistence';
import type { Observation } from '../../src/observation/types';

// Mock typed-confirm so we can control the operator response.
jest.mock('../../src/safety/typed-confirm', () => ({
  typedConfirmModal: jest.fn(),
}));
// Mock the delay module so no real pending-action files are written.
jest.mock('../../src/safety/delay', () => ({
  scheduleDelayedAction: jest.fn(),
  cancelDelayedAction: jest.fn(),
  loadPendingActions: jest.fn(),
}));
// Mock backup orchestrator so no real backup check runs.
jest.mock('../../src/backup/orchestrator', () => ({
  verifyBackup: jest.fn(),
}));

import { typedConfirmModal } from '../../src/safety/typed-confirm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStreams(): {
  captured: { stdout: string; stderr: string };
  streams: AutofixDeps['streams'];
} {
  const captured = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s: string) => { captured.stdout += s; },
      stderr: (s: string) => { captured.stderr += s; },
    },
  };
}

/** A minimal AuditWriter stub that records append calls. */
function makeAudit(): {
  audit: AutofixDeps['audit'];
  entries: Array<{ event: string; payload: Record<string, unknown> }>;
} {
  const entries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const audit = {
    append: jest.fn(async (_event: string, payload: Record<string, unknown>) => {
      entries.push({ event: _event as string, payload });
      return {
        seq: 1, timestamp: '', actor: '', platform: null, event: _event as never, payload, hmac: '',
      };
    }),
  } as unknown as AutofixDeps['audit'];
  return { audit, entries };
}

/** A mock Connection that records exec calls and returns a successful result. */
function makeConnection(exitCode = 0, stdout = 'ok'): {
  conn: import('../../src/connection/base').Connection;
  execMock: jest.Mock;
} {
  const execMock = jest.fn().mockResolvedValue({
    stdout,
    stderr: '',
    exitCode,
    durationMs: 10,
  });
  const conn = {
    platformId: 'swarm-01',
    exec: execMock,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    getCapabilities: () => undefined,
    getLastUsedAt: () => 0,
  } as unknown as import('../../src/connection/base').Connection;
  return { conn, execMock };
}

/** Create a temp data dir with a persisted observation. */
async function setupTmpDir(obs: Observation): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-test-'));
  const store = new ObservationStore(tmpDir);
  await store.save(obs);
  return tmpDir;
}

/** Create a crash_loop observation on a docker-swarm platform. */
function makeCrashLoopObs(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-crash-001',
    platform: 'docker-swarm-01',
    pattern: 'crash_loop',
    resource: 'service/my-web-service',
    severity: 'P0',
    discovered_at: new Date().toISOString(),
    details: { restart_count: 10 },
    dedup_key: 'docker-swarm-01:crash_loop:service/my-web-service',
    ...overrides,
  };
}

/** Read a proposal from the on-disk proposals dir. */
async function loadProposal(dataDir: string, proposalId: string): Promise<Proposal> {
  const raw = await fs.readFile(
    path.join(dataDir, '.autonomous-dev', 'proposals', `${proposalId}.json`),
    'utf8',
  );
  return JSON.parse(raw) as Proposal;
}

// ---------------------------------------------------------------------------
// (a) propose: crash_loop → real Action-bearing proposal
// ---------------------------------------------------------------------------

describe('autofix propose — crash_loop on docker-swarm', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await setupTmpDir(makeCrashLoopObs());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('produces a proposal with correct target_host, service, command, and destructiveness', async () => {
    const { audit } = makeAudit();
    const { streams } = captureStreams();
    const deps: AutofixDeps = { audit, streams, dataDir };

    const exit = await runAutofixPropose(deps, 'obs-crash-001');
    expect(exit).toBe(EXIT_OK);

    // Parse the proposal from stdout JSON.
    const parsed = JSON.parse(captureStreams().captured.stdout || '{}') as { proposal_id?: string };
    // Actually let's re-capture from the real streams:
    const { captured: cap2, streams: s2 } = captureStreams();
    const { audit: a2 } = makeAudit();
    const d2 = await setupTmpDir(makeCrashLoopObs());
    const exit2 = await runAutofixPropose({ audit: a2, streams: s2, dataDir: d2 }, 'obs-crash-001');
    expect(exit2).toBe(EXIT_OK);

    const out = JSON.parse(cap2.stdout) as { proposal_id: string; status: string; unsupported: boolean };
    expect(out.status).toBe('proposed');
    expect(out.unsupported).toBe(false);

    const proposal = await loadProposal(d2, out.proposal_id);
    expect(proposal.target_host).toBe('docker-swarm-01');
    expect(proposal.action_class).toBe('container.restart');
    expect(proposal.destructiveness).toBe('reversible');
    expect(proposal.ladder_level).toBe('L1');
    expect(proposal.requires_typed_confirm).toBe(true);
    expect(proposal.delay_hours).toBe(0);
    expect(proposal.params['service']).toBe('my-web-service');
    expect(proposal.params['command']).toBe('docker service update --force my-web-service');
    expect(proposal.unsupported).toBeUndefined();

    await fs.rm(d2, { recursive: true, force: true });
  });

  it('NOT the old hardcoded stub (target_host is not "unknown")', async () => {
    const { audit } = makeAudit();
    const { captured, streams } = captureStreams();
    const exit = await runAutofixPropose({ audit, streams, dataDir }, 'obs-crash-001');
    expect(exit).toBe(EXIT_OK);
    const out = JSON.parse(captured.stdout) as { proposal_id: string };
    const proposal = await loadProposal(dataDir, out.proposal_id);
    expect(proposal.target_host).not.toBe('unknown');
    expect(proposal.target_host).toBe('docker-swarm-01');
  });

  it('emits an audit event with correct fields', async () => {
    const { audit, entries } = makeAudit();
    const { streams } = captureStreams();
    await runAutofixPropose({ audit, streams, dataDir }, 'obs-crash-001');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload['type']).toBe('autofix.propose');
    expect(entries[0]?.payload['observation_id']).toBe('obs-crash-001');
    expect(entries[0]?.payload['action_class']).toBe('container.restart');
    expect(entries[0]?.payload['destructiveness']).toBe('reversible');
  });

  it('returns EXIT_FAIL when observation not found', async () => {
    const { audit } = makeAudit();
    const { captured, streams } = captureStreams();
    const exit = await runAutofixPropose({ audit, streams, dataDir }, 'obs-does-not-exist');
    expect(exit).toBe(EXIT_FAIL);
    expect(captured.stderr).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// (d) unsupported pattern → no-op proposal
// ---------------------------------------------------------------------------

describe('autofix propose — unsupported pattern (daemon_heartbeat_stale)', () => {
  let dataDir: string;

  beforeEach(async () => {
    const obs: Observation = {
      id: 'obs-daemon-001',
      platform: 'docker-swarm-01',
      pattern: 'daemon_heartbeat_stale',
      resource: 'docker-daemon',
      severity: 'P1',
      discovered_at: new Date().toISOString(),
    };
    dataDir = await setupTmpDir(obs);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('produces a no-op proposal with unsupported=true, NOT a bogus mutation', async () => {
    const { audit } = makeAudit();
    const { captured, streams } = captureStreams();
    const exit = await runAutofixPropose({ audit, streams, dataDir }, 'obs-daemon-001');
    expect(exit).toBe(EXIT_OK);

    const out = JSON.parse(captured.stdout) as { proposal_id: string; status: string; unsupported: boolean };
    expect(out.status).toBe('proposed');
    expect(out.unsupported).toBe(true);

    const proposal = await loadProposal(dataDir, out.proposal_id);
    expect(proposal.unsupported).toBe(true);
    expect(proposal.action_class).toBe('noop');
    expect(proposal.destructiveness).toBe('read-only');
    expect(proposal.params['pattern']).toBe('daemon_heartbeat_stale');
  });

  it('apply rejects an unsupported proposal immediately', async () => {
    const { audit } = makeAudit();
    const { captured, streams } = captureStreams();

    // First propose (creates the unsupported proposal).
    const propOut = JSON.parse(
      await (async () => {
        const { captured: c, streams: s } = captureStreams();
        await runAutofixPropose({ audit, streams: s, dataDir }, 'obs-daemon-001');
        return c.stdout;
      })(),
    ) as { proposal_id: string };

    // Now apply — should fail immediately with a clear message.
    const exit = await runAutofixApply({ audit, streams, dataDir }, propOut.proposal_id);
    expect(exit).toBe(EXIT_FAIL);
    expect(captured.stderr).toMatch(/no supported remediation/);
    expect(typedConfirmModal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) dry-run: reflects real destructiveness classification
// ---------------------------------------------------------------------------

describe('autofix dry-run', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await setupTmpDir(makeCrashLoopObs());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reflects reversible → WOULD_REQUIRE_TYPED_CONFIRM for a crash_loop proposal', async () => {
    const { audit } = makeAudit();
    const { streams } = captureStreams();

    // First create a proposal.
    const { captured: propCap, streams: propStreams } = captureStreams();
    await runAutofixPropose({ audit, streams: propStreams, dataDir }, 'obs-crash-001');
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    // Now dry-run.
    const { captured, streams: dryStreams } = captureStreams();
    const exit = await runAutofixDryRun({ audit, streams: dryStreams, dataDir }, proposal_id);
    expect(exit).toBe(EXIT_OK);

    // dry-run prints a JSON line then a human-readable line; parse only the JSON line.
    const jsonLine = captured.stdout.split('\n').find((l) => l.startsWith('{'));
    const out = JSON.parse(jsonLine ?? '{}') as {
      proposal_id: string;
      gate_outcome: string;
      destructiveness: string;
    };
    expect(out.gate_outcome).toBe('WOULD_REQUIRE_TYPED_CONFIRM');
    expect(out.destructiveness).toBe('reversible');
    expect(captured.stdout).toMatch(/WOULD_REQUIRE_TYPED_CONFIRM/);
  });

  it('does NOT hardcode the outcome — unsupported noop → WOULD_EXECUTE_L2_PLUS (read-only)', async () => {
    // Create an unsupported-pattern observation and its proposal.
    const noopDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-noop-'));
    try {
      const obs: Observation = {
        id: 'obs-noop-001',
        platform: 'docker-swarm-01',
        pattern: 'daemon_heartbeat_stale',
        resource: 'docker-daemon',
        severity: 'P1',
        discovered_at: new Date().toISOString(),
      };
      const store = new ObservationStore(noopDir);
      await store.save(obs);

      const { audit } = makeAudit();
      const { captured: propCap, streams: propStreams } = captureStreams();
      await runAutofixPropose({ audit, streams: propStreams, dataDir: noopDir }, 'obs-noop-001');
      const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

      const { captured, streams } = captureStreams();
      const exit = await runAutofixDryRun({ audit, streams, dataDir: noopDir }, proposal_id);
      expect(exit).toBe(EXIT_OK);
      const jsonLine2 = captured.stdout.split('\n').find((l) => l.startsWith('{'));
      const out = JSON.parse(jsonLine2 ?? '{}') as { gate_outcome: string; destructiveness: string };
      expect(out.gate_outcome).toBe('WOULD_EXECUTE_L2_PLUS');
      expect(out.destructiveness).toBe('read-only');
    } finally {
      await fs.rm(noopDir, { recursive: true, force: true });
    }
  });

  it('returns EXIT_FAIL when proposal not found', async () => {
    const { audit } = makeAudit();
    const { captured, streams } = captureStreams();
    const exit = await runAutofixDryRun({ audit, streams, dataDir }, 'prop-does-not-exist');
    expect(exit).toBe(EXIT_FAIL);
    expect(captured.stderr).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// (c) apply: executes via mock connection; denies without CONFIRM
// ---------------------------------------------------------------------------

describe('autofix apply — confirmation given', () => {
  let dataDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    (typedConfirmModal as jest.Mock).mockResolvedValue(true);
    dataDir = await setupTmpDir(makeCrashLoopObs());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('executes remediation command via mock connection on approval', async () => {
    const { audit, entries } = makeAudit();
    const { conn, execMock } = makeConnection(0, 'service updated');

    // Create proposal first.
    const { captured: propCap, streams: propStreams } = captureStreams();
    await runAutofixPropose({ audit, streams: propStreams, dataDir }, 'obs-crash-001');
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    // Apply with mocked confirmation and mock connection.
    const { captured, streams } = captureStreams();
    const exit = await runAutofixApply({
      audit,
      streams,
      dataDir,
      getConnection: async () => conn,
      _testConfirmAnswer: 'CONFIRM',
    }, proposal_id);

    expect(exit).toBe(EXIT_OK);
    // exec was called with the correct command.
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('docker service update --force my-web-service');

    // Audit contains autofix.apply event.
    const applyEntry = entries.find((e) => e.payload['type'] === 'autofix.apply');
    expect(applyEntry).toBeDefined();
    expect(applyEntry?.payload['exit_code']).toBe(0);
    expect(applyEntry?.payload['command']).toBe('docker service update --force my-web-service');

    // stdout confirms success.
    const out = JSON.parse(captured.stdout.split('\n').find(l => l.startsWith('{')) ?? '{}') as {
      status: string;
      exit_code: number;
    };
    expect(out.status).toBe('applied');
    expect(out.exit_code).toBe(0);
  });

  it('returns EXIT_FAIL and emits audit when exec command exits non-zero', async () => {
    const { audit, entries } = makeAudit();
    const { conn } = makeConnection(1, '');

    const { captured: propCap, streams: propStreams } = captureStreams();
    await runAutofixPropose({ audit, streams: propStreams, dataDir }, 'obs-crash-001');
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    const { captured, streams } = captureStreams();
    const exit = await runAutofixApply({
      audit,
      streams,
      dataDir,
      getConnection: async () => conn,
      _testConfirmAnswer: 'CONFIRM',
    }, proposal_id);

    expect(exit).toBe(EXIT_FAIL);
    const applyEntry = entries.find((e) => e.payload['type'] === 'autofix.apply');
    expect(applyEntry?.payload['exit_code']).toBe(1);
  });
});

describe('autofix apply — confirmation refused', () => {
  let dataDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    (typedConfirmModal as jest.Mock).mockResolvedValue(false);
    dataDir = await setupTmpDir(makeCrashLoopObs());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('does NOT execute exec and returns EXIT_FAIL with gate.denied audit', async () => {
    const { audit, entries } = makeAudit();
    const { conn, execMock } = makeConnection();

    const { captured: propCap, streams: propStreams } = captureStreams();
    await runAutofixPropose({ audit, streams: propStreams, dataDir }, 'obs-crash-001');
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    const { captured, streams } = captureStreams();
    const exit = await runAutofixApply({
      audit,
      streams,
      dataDir,
      getConnection: async () => conn,
      _testConfirmAnswer: 'WRONG_ANSWER',
    }, proposal_id);

    expect(exit).toBe(EXIT_FAIL);
    // exec MUST NOT have been called.
    expect(execMock).not.toHaveBeenCalled();
    // Gate denial message in stderr.
    expect(captured.stderr).toMatch(/Gate denied/);
    // gate.denied audit event emitted via the gate's ctx.audit.
    const gateDenied = entries.find((e) => e.payload['type'] === 'gate.denied');
    expect(gateDenied).toBeDefined();
  });

  it('uses _testConfirmAnswer seam — empty string also denies', async () => {
    const { audit } = makeAudit();
    const { conn, execMock } = makeConnection();

    const { captured: propCap, streams: propStreams } = captureStreams();
    await runAutofixPropose({ audit, streams: propStreams, dataDir }, 'obs-crash-001');
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    const { streams } = captureStreams();
    const exit = await runAutofixApply({
      audit,
      streams,
      dataDir,
      getConnection: async () => conn,
      _testConfirmAnswer: '',
    }, proposal_id);

    expect(exit).toBe(EXIT_FAIL);
    expect(execMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildAutofixCommand: Commander integration
// ---------------------------------------------------------------------------

describe('buildAutofixCommand', () => {
  let dataDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    (typedConfirmModal as jest.Mock).mockResolvedValue(true);
    dataDir = await setupTmpDir(makeCrashLoopObs());
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('propose subcommand is wired and exits 0 on success', async () => {
    const { audit } = makeAudit();
    const { streams } = captureStreams();
    const handle = buildAutofixCommand({ audit, streams, dataDir });
    await handle.command.parseAsync(['propose', 'obs-crash-001'], { from: 'user' });
    expect(handle.lastExitCode()).toBe(EXIT_OK);
  });

  it('apply subcommand is wired into the command tree', () => {
    const { audit } = makeAudit();
    const { streams } = captureStreams();
    const handle = buildAutofixCommand({ audit, streams, dataDir });
    const names = handle.command.commands.map((c) => c.name());
    expect(names).toContain('apply');
  });

  it('apply via Commander executes successfully with mock connection and CONFIRM', async () => {
    const { audit } = makeAudit();
    const { conn } = makeConnection(0);

    // Create proposal first.
    const { captured: propCap, streams: propStreams } = captureStreams();
    const propHandle = buildAutofixCommand({ audit, streams: propStreams, dataDir });
    await propHandle.command.parseAsync(['propose', 'obs-crash-001'], { from: 'user' });
    const { proposal_id } = JSON.parse(propCap.stdout) as { proposal_id: string };

    const { streams } = captureStreams();
    const applyHandle = buildAutofixCommand({
      audit,
      streams,
      dataDir,
      getConnection: async () => conn,
      _testConfirmAnswer: 'CONFIRM',
    });
    await applyHandle.command.parseAsync(['apply', proposal_id], { from: 'user' });
    expect(applyHandle.lastExitCode()).toBe(EXIT_OK);
  });
});
