/**
 * Unit tests for `UnraidConnection`. Implements SPEC-001-2-05
 * §"Per-Subclass Unit Tests" for Unraid (SSH-only).
 *
 * No MCP, no REST. The only transport is SSH cert auth. Tests verify
 * connect/exec/disconnect happy paths and that no MCP/HTTPS code paths
 * are reachable from this subclass.
 */

import { UnraidConnection } from '../../src/connection/unraid';
import { ConnectionTimeoutError, SSHAuthError } from '../../src/connection/errors';
import { SSHClient, type SSHRunner } from '../../src/connection/ssh-client';

function okRunner(): SSHRunner {
  return jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
}

const baseOpts = {
  hostname: 'unraid.local',
  sshUser: 'root',
  privateKeyPath: '/tmp/key',
  certPath: '/tmp/key-cert.pub',
};

describe('UnraidConnection', () => {
  describe('connect()', () => {
    it('uses SSH transport on cert preflight success', async () => {
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
      expect(conn.getCapabilities()?.user).toBe('root');
      expect(conn.isConnected()).toBe(true);
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('throws SSHAuthError when SSH preflight returns non-zero', async () => {
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: 'denied',
        exitCode: 255,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await expect(conn.connect()).rejects.toBeInstanceOf(SSHAuthError);
      expect(conn.isConnected()).toBe(false);
    });

    it('does not attempt any MCP or HTTPS preflight (verified by no extra calls)', async () => {
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      // Spy on globalThis.fetch to ensure it is never called.
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('fetch should not be called by UnraidConnection');
      });
      try {
        const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
        await conn.connect();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('exec()', () => {
    it('routes commands through SSH', async () => {
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) // preflight
        .mockResolvedValueOnce({ stdout: 'array started\n', stderr: '', exitCode: 0, timedOut: false });
      const ssh = new SSHClient({ runner });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('mdcmd status');
      expect(r.stdout).toBe('array started\n');
      expect(r.exitCode).toBe(0);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('does not throw when remote command exits non-zero', async () => {
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
        .mockResolvedValueOnce({ stdout: '', stderr: 'oops', exitCode: 7, timedOut: false });
      const ssh = new SSHClient({ runner });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('false');
      expect(r.exitCode).toBe(7);
    });

    it('throws ConnectionTimeoutError when SSH runner reports timeout', async () => {
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: true });
      const ssh = new SSHClient({ runner });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      await expect(conn.exec('sleep 10', { timeoutMs: 100 })).rejects.toBeInstanceOf(ConnectionTimeoutError);
    });

    it('throws SSHAuthError when called before connect()', async () => {
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await expect(conn.exec('whoami')).rejects.toBeInstanceOf(SSHAuthError);
    });
  });

  describe('disconnect()', () => {
    it('is idempotent', async () => {
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
    });

    it('marks isConnected() false', async () => {
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new UnraidConnection('unraid-01', { ...baseOpts, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      expect(conn.isConnected()).toBe(false);
    });
  });
});
