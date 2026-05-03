/**
 * `platform exec` subcommand tests. Implements the SPEC-001-3-04 §"`platform
 * exec`" acceptance criteria:
 *
 * - Happy path: opens connection, runs command, prints result + exit 0.
 * - Unknown platform-id → EXIT_USAGE with the not-found error.
 * - Connection failure → EXIT_CONNECT_FAIL with structured error.
 * - Non-zero exit → EXIT_CONNECT_FAIL with the result still printed.
 * - Timeout → EXIT_CONNECT_FAIL, exit_code:-1, error:'timeout'.
 * - Transport selection (mcp_endpoint set vs SSH) is delegated to the
 *   connection layer, but the test asserts the pool factory is invoked.
 *
 * Tests build the Commander handle directly via `buildPlatformCommand`
 * with mocked InventoryManager + ConnectionPool, so no real network /
 * subprocess. The `requiresAdmin` enforcement lives at the dispatcher
 * level (SPEC-001-3-04) and is exercised by `test-admin-auth-middleware`.
 */

import {
  buildPlatformCommand,
  EXIT_CONNECT_FAIL,
  type PlatformCommandDeps,
} from '../../src/cli/commands/platform';
import type { Connection } from '../../src/connection/base';
import type { Platform } from '../../src/discovery/inventory-types';
import { ConnectionPool } from '../../src/connection/pool';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams(): {
  captured: CapturedStreams;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const captured: CapturedStreams = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s) => {
        captured.stdout += s;
      },
      stderr: (s) => {
        captured.stderr += s;
      },
    },
  };
}

class FakeConnection {
  public capabilities = {
    transport: 'ssh' as const,
    hostname: 'proxmox-01.lan',
    user: 'root',
    certFingerprint: 'SHA256:fakecert',
  };
  public connected = true;
  public execImpl: (
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> = async (
    cmd,
  ) => ({
    stdout: cmd === 'whoami' ? 'root\n' : `ran ${cmd}\n`,
    stderr: '',
    exitCode: 0,
    durationMs: 142,
  });

  async connect(): Promise<void> {
    this.connected = true;
  }
  async exec(
    command: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    return this.execImpl(command);
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  getCapabilities(): typeof this.capabilities {
    return this.capabilities;
  }
  getLastUsedAt(): number {
    return 0;
  }
  readonly platformId = 'proxmox-01';
}

function makeInventory(map: Record<string, Platform>): {
  getPlatform: (id: string) => Promise<Platform | null>;
} {
  return {
    getPlatform: async (id) => map[id] ?? null,
  };
}

function platformEntry(id: string, withMcp = false): Platform {
  const now = new Date().toISOString();
  const base: Platform = {
    id,
    type: 'proxmox-ve',
    host: '192.168.1.50',
    port: 8006,
    discovered_at: now,
    last_seen: now,
  };
  if (withMcp) base.connection = { mcp_endpoint: 'mcp-server-proxmox' };
  return base;
}

// Stub deps for fields the exec subcommand never touches; satisfies the
// PlatformCommandDeps type without needing real CA/passphrase wiring.
function stubCAManager(): PlatformCommandDeps['caManager'] {
  return {} as PlatformCommandDeps['caManager'];
}
function stubPassphrase(): PlatformCommandDeps['passphrase'] {
  return {} as PlatformCommandDeps['passphrase'];
}

async function runArgs(deps: PlatformCommandDeps, argv: string[]): Promise<number> {
  const handle = buildPlatformCommand(deps);
  handle.command.exitOverride();
  await handle.command.parseAsync(argv, { from: 'user' });
  return handle.lastExitCode();
}

describe('platform exec', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkTempDir('platform-exec-');
  });
  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  test('happy path: prints stdout and exit 0 (plain)', async () => {
    const { streams, captured } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new FakeConnection() as unknown as Connection),
        streams,
      },
      ['exec', 'proxmox-01', '--', 'whoami'],
    );
    expect(code).toBe(0);
    expect(captured.stdout).toContain('root\n');
    expect(captured.stdout).toMatch(/exit: 0\s+duration: 142ms/);
  });

  test('--json emits structured success result', async () => {
    const { streams, captured } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new FakeConnection() as unknown as Connection),
        streams,
      },
      ['exec', 'proxmox-01', '--json', '--', 'whoami'],
    );
    expect(code).toBe(0);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.ok).toBe(true);
    expect(obj.platform_id).toBe('proxmox-01');
    expect(obj.command).toBe('whoami');
    expect(obj.stdout).toBe('root\n');
    expect(obj.exit_code).toBe(0);
    expect(typeof obj.duration_ms).toBe('number');
  });

  test('unknown platform-id exits 1 with not-found error', async () => {
    const { streams, captured } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({}) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new FakeConnection() as unknown as Connection),
        streams,
      },
      ['exec', 'unknown-id', '--', 'whoami'],
    );
    expect(code).toBe(1);
    expect(captured.stderr).toContain("no platform 'unknown-id' in inventory");
  });

  test('connection failure: EXIT_CONNECT_FAIL with structured error in --json', async () => {
    class FailingConn extends FakeConnection {
      override async connect(): Promise<void> {
        const err = new Error('SSHAuthError: cert rejected') as Error & { code?: string };
        err.code = 'SSH_AUTH_FAILED';
        throw err;
      }
    }
    const { streams, captured } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new FailingConn() as unknown as Connection),
        streams,
      },
      ['exec', 'proxmox-01', '--json', '--', 'whoami'],
    );
    expect(code).toBe(EXIT_CONNECT_FAIL);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.ok).toBe(false);
    const err = obj.error as Record<string, string>;
    expect(err.message).toMatch(/cert rejected/);
    expect(err.code).toBe('SSH_AUTH_FAILED');
  });

  test('non-zero command exit: still prints stdout, exit 1', async () => {
    class NonZeroConn extends FakeConnection {
      override execImpl = async (
        cmd: string,
      ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> => ({
        stdout: 'partial\n',
        stderr: 'oops\n',
        exitCode: 2,
        durationMs: 9,
      });
    }
    const { streams, captured } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new NonZeroConn() as unknown as Connection),
        streams,
      },
      ['exec', 'proxmox-01', '--', 'falsey'],
    );
    expect(code).toBe(EXIT_CONNECT_FAIL);
    expect(captured.stdout).toContain('partial\n');
    expect(captured.stdout).toMatch(/exit: 2/);
    expect(captured.stderr).toContain('oops\n');
  });

  test('--timeout kills the connection; exit_code=-1, error=timeout', async () => {
    class HangingConn extends FakeConnection {
      override async connect(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    const { streams, captured } = captureStreams();
    const start = Date.now();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new HangingConn() as unknown as Connection),
        streams,
      },
      // 1 second timeout (CLI takes seconds, not ms)
      ['exec', 'proxmox-01', '--timeout', '1', '--json', '--', 'whoami'],
    );
    const elapsed = Date.now() - start;
    expect(code).toBe(EXIT_CONNECT_FAIL);
    expect(elapsed).toBeLessThan(3000);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.ok).toBe(false);
    expect(obj.exit_code).toBe(-1);
    expect(obj.error).toBe('timeout');
  });

  test('factory is invoked with the platform-id (transport selection delegated)', async () => {
    const seenIds: string[] = [];
    const { streams } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01', true),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, (id: string) => {
          seenIds.push(id);
          return new FakeConnection() as unknown as Connection;
        }),
        streams,
      },
      ['exec', 'proxmox-01', '--', 'whoami'],
    );
    expect(code).toBe(0);
    expect(seenIds).toEqual(['proxmox-01']);
  });

  test('multi-token command joined with spaces and forwarded to exec', async () => {
    const seenCommands: string[] = [];
    class CapturingConn extends FakeConnection {
      override execImpl = async (cmd: string) => {
        seenCommands.push(cmd);
        return { stdout: cmd, stderr: '', exitCode: 0, durationMs: 1 };
      };
    }
    const { streams } = captureStreams();
    const code = await runArgs(
      {
        inventoryManager: makeInventory({
          'proxmox-01': platformEntry('proxmox-01'),
        }) as PlatformCommandDeps['inventoryManager'],
        caManager: stubCAManager(),
        passphrase: stubPassphrase(),
        pool: new ConnectionPool({}, () => new CapturingConn() as unknown as Connection),
        streams,
      },
      ['exec', 'proxmox-01', '--', 'pveversion', '-v'],
    );
    expect(code).toBe(0);
    expect(seenCommands).toEqual(['pveversion -v']);
  });

  test('appears in --help output', async () => {
    const { streams, captured } = captureStreams();
    const handle = buildPlatformCommand({
      inventoryManager: makeInventory({}) as PlatformCommandDeps['inventoryManager'],
      caManager: stubCAManager(),
      passphrase: stubPassphrase(),
      pool: new ConnectionPool({}, () => new FakeConnection() as unknown as Connection),
      streams,
    });
    handle.command.exitOverride();
    handle.command.configureOutput({
      writeOut: (s) => streams.stdout(s),
      writeErr: (s) => streams.stderr(s),
    });
    try {
      await handle.command.parseAsync(['platform', '--help'], { from: 'user' });
    } catch (err) {
      const code = (err as { code?: string }).code;
      expect(code === 'commander.helpDisplayed' || code === 'commander.help').toBe(true);
    }
    expect(captured.stdout).toMatch(/exec/);
  });
});
