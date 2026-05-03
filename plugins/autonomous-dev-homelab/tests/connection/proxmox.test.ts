/**
 * Unit tests for `ProxmoxConnection`. Implements SPEC-001-2-05
 * §"Per-Subclass Unit Tests" for the Proxmox subclass.
 *
 * Pure unit tests: every dependency (MCPClient, SSHClient) is mocked. No
 * real network or `ssh-keygen` invocations happen.
 */

import { ProxmoxConnection } from '../../src/connection/proxmox';
import { MCPUnavailableError, SSHAuthError, ConnectionTimeoutError } from '../../src/connection/errors';
import type { MCPCallResult, MCPClient } from '../../src/connection/mcp-client';
import { SSHClient, type SSHRunner } from '../../src/connection/ssh-client';

interface MCPMockOverrides {
  connect?: jest.Mock;
  call?: jest.Mock;
  disconnect?: jest.Mock;
  isConnected?: jest.Mock;
}

function makeMockMCP(overrides: MCPMockOverrides = {}): jest.Mocked<MCPClient> {
  const defaults = {
    connect: jest.fn().mockResolvedValue(undefined),
    call: jest.fn().mockResolvedValue({ content: { stdout: '', stderr: '', exitCode: 0 }, isError: false } as MCPCallResult),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
  };
  return { ...defaults, ...overrides } as unknown as jest.Mocked<MCPClient>;
}

function makeMockSSH(runner?: SSHRunner): SSHClient {
  const defaultRunner: SSHRunner = jest.fn().mockResolvedValue({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
  });
  return new SSHClient({ runner: runner ?? defaultRunner });
}

const baseOpts = {
  hostname: 'pve.local',
  sshUser: 'root',
  privateKeyPath: '/tmp/key',
  certPath: '/tmp/key-cert.pub',
};

describe('ProxmoxConnection', () => {
  describe('connect()', () => {
    it('uses MCP transport when MCP server connects', async () => {
      const mcp = makeMockMCP();
      const ssh = makeMockSSH();
      const sshConnect = jest.spyOn(ssh, 'connect');
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('mcp');
      expect(conn.getCapabilities()?.serverName).toBe('mcp-server-proxmox');
      expect(conn.isConnected()).toBe(true);
      expect(mcp.connect).toHaveBeenCalledTimes(1);
      expect(sshConnect).not.toHaveBeenCalled();
    });

    it('falls back to SSH when MCP throws MCPUnavailableError', async () => {
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('not_installed')),
      });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
      expect(conn.getCapabilities()?.user).toBe('root');
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('falls back to SSH when MCP times out', async () => {
      // Avoid real timers: use a slow promise that never resolves and rely
      // on the timeout in withMCPTimeout. We use fake timers here to advance.
      jest.useFakeTimers();
      const slowConnect = jest.fn().mockReturnValue(new Promise(() => undefined));
      const mcp = makeMockMCP({ connect: slowConnect });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', {
        ...baseOpts,
        mcpClient: mcp,
        sshClient: ssh,
        mcpTimeoutMs: 5000,
      });
      const p = conn.connect();
      await Promise.resolve();
      jest.advanceTimersByTime(5001);
      jest.useRealTimers();
      await p;
      expect(conn.getCapabilities()?.transport).toBe('ssh');
    });

    it('throws SSHAuthError with attached mcpError when both fail', async () => {
      const mcpErr = new MCPUnavailableError('not_installed');
      const mcp = makeMockMCP({ connect: jest.fn().mockRejectedValue(mcpErr) });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: 'Permission denied',
        exitCode: 255,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      let caught: SSHAuthError | undefined;
      try {
        await conn.connect();
      } catch (err) {
        caught = err as SSHAuthError;
      }
      expect(caught).toBeInstanceOf(SSHAuthError);
      expect(caught?.mcpError).toBe(mcpErr);
    });

    it('logs the MCP failure reason at debug level', async () => {
      const debug = jest.fn();
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('connection_refused', 'nope')),
      });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', {
        ...baseOpts,
        mcpClient: mcp,
        sshClient: ssh,
        logger: { debug },
      });
      await conn.connect();
      expect(debug).toHaveBeenCalledWith(
        'mcp_unavailable_falling_back_to_ssh',
        expect.objectContaining({ reason: 'connection_refused' }),
      );
    });

    it('honors preferTransport=ssh and skips MCP entirely', async () => {
      const mcp = makeMockMCP();
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', {
        ...baseOpts,
        mcpClient: mcp,
        sshClient: ssh,
        preferTransport: 'ssh',
      });
      await conn.connect();
      expect(mcp.connect).not.toHaveBeenCalled();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
    });
  });

  describe('exec()', () => {
    it('routes through MCP when MCP transport is active', async () => {
      const mcp = makeMockMCP({
        call: jest.fn().mockResolvedValue({
          content: { stdout: 'hello\n', stderr: '', exitCode: 0 },
          isError: false,
        } as MCPCallResult),
      });
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('echo hello');
      expect(mcp.call).toHaveBeenCalledWith('shell_exec', { command: 'echo hello' }, expect.any(Number));
      expect(r.stdout).toBe('hello\n');
      expect(r.exitCode).toBe(0);
    });

    it('routes through SSH when SSH transport is active', async () => {
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('not_installed')),
      });
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) // preflight
        .mockResolvedValueOnce({ stdout: 'whoami-out\n', stderr: '', exitCode: 0, timedOut: false });
      const ssh = new SSHClient({ runner });
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('whoami');
      expect(r.stdout).toBe('whoami-out\n');
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('returns ExecResult with measured durationMs >= 0', async () => {
      const mcp = makeMockMCP();
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('uptime');
      expect(typeof r.durationMs).toBe('number');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not throw when remote command exits non-zero (MCP)', async () => {
      const mcp = makeMockMCP({
        call: jest.fn().mockResolvedValue({
          content: { stdout: '', stderr: 'oops', exitCode: 17 },
          isError: false,
        } as MCPCallResult),
      });
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('false');
      expect(r.exitCode).toBe(17);
    });

    it('throws ConnectionTimeoutError on per-call timeout (MCP)', async () => {
      jest.useFakeTimers();
      const mcp = makeMockMCP({
        call: jest.fn().mockReturnValue(new Promise(() => undefined)),
      });
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const p = conn.exec('sleep 99', { timeoutMs: 100 });
      // Catch immediately to register the rejection handler before timers fire.
      const errPromise = p.catch((e) => e);
      jest.advanceTimersByTime(101);
      jest.useRealTimers();
      const err = await errPromise;
      expect(err).toBeInstanceOf(ConnectionTimeoutError);
      expect((err as ConnectionTimeoutError).transport).toBe('mcp');
    });

    it('throws SSHAuthError when called before connect()', async () => {
      const conn = new ProxmoxConnection('pve-01', {
        ...baseOpts,
        mcpClient: makeMockMCP(),
        sshClient: makeMockSSH(),
      });
      await expect(conn.exec('whoami')).rejects.toBeInstanceOf(SSHAuthError);
    });
  });

  describe('disconnect()', () => {
    it('is idempotent across MCP transport', async () => {
      const mcp = makeMockMCP();
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
      expect(conn.isConnected()).toBe(false);
    });

    it('marks isConnected() false', async () => {
      const mcp = makeMockMCP();
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.isConnected()).toBe(true);
      await conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });

    it('tolerates underlying MCP disconnect errors', async () => {
      const mcp = makeMockMCP({
        disconnect: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const ssh = makeMockSSH();
      const conn = new ProxmoxConnection('pve-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
    });
  });
});
