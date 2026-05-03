/**
 * Unit tests for `DockerConnection`. Implements SPEC-001-2-05
 * §"Per-Subclass Unit Tests" for the Docker subclass. Same shape as
 * `proxmox.test.ts` because Docker shares the MCP-first / SSH-fallback
 * machinery via `MCPOrSSHConnection`.
 */

import { DockerConnection } from '../../src/connection/docker';
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

function okRunner(): SSHRunner {
  return jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
}

const baseOpts = {
  hostname: 'docker.local',
  sshUser: 'root',
  privateKeyPath: '/tmp/key',
  certPath: '/tmp/key-cert.pub',
};

describe('DockerConnection', () => {
  describe('connect()', () => {
    it('uses MCP transport when MCP server connects', async () => {
      const mcp = makeMockMCP();
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('mcp');
      expect(conn.getCapabilities()?.serverName).toBe('mcp-server-docker');
      expect(runner).not.toHaveBeenCalled();
    });

    it('falls back to SSH when MCP throws', async () => {
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('not_installed')),
      });
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('falls back to SSH when MCP times out', async () => {
      jest.useFakeTimers();
      const mcp = makeMockMCP({ connect: jest.fn().mockReturnValue(new Promise(() => undefined)) });
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      const conn = new DockerConnection('docker-01', {
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
      const mcpErr = new MCPUnavailableError('connection_refused');
      const mcp = makeMockMCP({ connect: jest.fn().mockRejectedValue(mcpErr) });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: 'denied',
        exitCode: 255,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      const err = await conn.connect().catch((e) => e);
      expect(err).toBeInstanceOf(SSHAuthError);
      expect((err as SSHAuthError).mcpError).toBe(mcpErr);
    });

    it('logs MCP failure reason at debug level', async () => {
      const debug = jest.fn();
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('auth_failed')),
      });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', {
        ...baseOpts,
        mcpClient: mcp,
        sshClient: ssh,
        logger: { debug },
      });
      await conn.connect();
      expect(debug).toHaveBeenCalledWith(
        'mcp_unavailable_falling_back_to_ssh',
        expect.objectContaining({ reason: 'auth_failed' }),
      );
    });
  });

  describe('exec()', () => {
    it('routes through MCP when MCP transport is active', async () => {
      const mcp = makeMockMCP({
        call: jest.fn().mockResolvedValue({
          content: { stdout: 'CONTAINER ID\n', stderr: '', exitCode: 0 },
          isError: false,
        } as MCPCallResult),
      });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('docker ps');
      expect(mcp.call).toHaveBeenCalledWith('shell_exec', { command: 'docker ps' }, expect.any(Number));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('CONTAINER ID');
    });

    it('routes through SSH when SSH transport is active', async () => {
      const mcp = makeMockMCP({
        connect: jest.fn().mockRejectedValue(new MCPUnavailableError('not_installed')),
      });
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
        .mockResolvedValueOnce({ stdout: 'image-list', stderr: '', exitCode: 0, timedOut: false });
      const ssh = new SSHClient({ runner });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('docker images');
      expect(r.stdout).toBe('image-list');
    });

    it('returns ExecResult with measured durationMs >= 0', async () => {
      const mcp = makeMockMCP();
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('uptime');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not throw when remote command exits non-zero', async () => {
      const mcp = makeMockMCP({
        call: jest.fn().mockResolvedValue({
          content: { stdout: '', stderr: 'no such container', exitCode: 1 },
          isError: false,
        } as MCPCallResult),
      });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('docker stop missing');
      expect(r.exitCode).toBe(1);
    });

    it('throws ConnectionTimeoutError on per-call timeout (MCP)', async () => {
      jest.useFakeTimers();
      const mcp = makeMockMCP({
        call: jest.fn().mockReturnValue(new Promise(() => undefined)),
      });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      const p = conn.exec('sleep 99', { timeoutMs: 50 });
      const errPromise = p.catch((e) => e);
      jest.advanceTimersByTime(51);
      jest.useRealTimers();
      const err = await errPromise;
      expect(err).toBeInstanceOf(ConnectionTimeoutError);
    });
  });

  describe('disconnect()', () => {
    it('is idempotent', async () => {
      const mcp = makeMockMCP();
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
    });

    it('marks isConnected() false', async () => {
      const mcp = makeMockMCP();
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new DockerConnection('docker-01', { ...baseOpts, mcpClient: mcp, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });
  });
});
