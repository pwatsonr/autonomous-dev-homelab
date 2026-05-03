/**
 * Unit tests for `TrueNasConnection`. Implements SPEC-001-2-05
 * §"Per-Subclass Unit Tests" for TrueNAS (REST-first, SSH fallback).
 *
 * Covers:
 * - REST preflight success → https transport, exec routes JSON descriptors,
 * - REST preflight failure → SSH fallback path, exec routes shell commands,
 * - capability `transport` reflects the active transport,
 * - disconnect is idempotent.
 */

import { TrueNasConnection } from '../../src/connection/truenas';
import { SSHAuthError, UnsupportedExecError } from '../../src/connection/errors';
import { HTTPSClient, type FetchFn } from '../../src/connection/https-client';
import { SSHClient, type SSHRunner } from '../../src/connection/ssh-client';

function makeFetch(seq: Array<() => { status: number; body: unknown }>): jest.MockedFunction<FetchFn> {
  let i = 0;
  const fn: FetchFn = async (_url, _init) => {
    void _url;
    void _init;
    const next = seq[Math.min(i, seq.length - 1)];
    i += 1;
    const r = next!();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
    });
  };
  return jest.fn(fn) as jest.MockedFunction<FetchFn>;
}

function okRunner(): SSHRunner {
  return jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
}

const baseOpts = {
  hostname: 'truenas.local',
  baseUrl: 'https://truenas.local',
  apiToken: 'tok',
  privateKeyPath: '/tmp/key',
  certPath: '/tmp/key-cert.pub',
};

describe('TrueNasConnection', () => {
  describe('connect()', () => {
    it('uses HTTPS transport when REST preflight succeeds', async () => {
      const fetchFn = makeFetch([() => ({ status: 200, body: { hostname: 'truenas.local' } })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: baseOpts.apiToken }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const sshSpy = jest.spyOn(ssh, 'connect');
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('https');
      expect(sshSpy).not.toHaveBeenCalled();
    });

    it('falls back to SSH when REST returns non-2xx', async () => {
      const fetchFn = makeFetch([() => ({ status: 500, body: 'oops' })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: baseOpts.apiToken }, { fetch: fetchFn });
      const runner = okRunner();
      const ssh = new SSHClient({ runner });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('falls back to SSH when fetch throws (network failure)', async () => {
      const throwing: FetchFn = async (_url, _init) => {
        void _url;
        void _init;
        throw new Error('ECONNREFUSED');
      };
      const fetchFn = jest.fn(throwing) as jest.MockedFunction<FetchFn>;
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      expect(conn.getCapabilities()?.transport).toBe('ssh');
    });

    it('propagates SSH preflight failure when both REST and SSH fail', async () => {
      const fetchFn = makeFetch([() => ({ status: 503, body: '' })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const runner: SSHRunner = jest.fn().mockResolvedValue({
        stdout: '',
        stderr: 'denied',
        exitCode: 255,
        timedOut: false,
      });
      const ssh = new SSHClient({ runner });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await expect(conn.connect()).rejects.toBeInstanceOf(SSHAuthError);
    });
  });

  describe('exec()', () => {
    it('routes JSON descriptor through HTTPS when REST is active', async () => {
      const fetchFn = makeFetch([
        () => ({ status: 200, body: { ok: true } }),
        () => ({ status: 200, body: { pools: ['tank'] } }),
      ]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec(JSON.stringify({ method: 'GET', path: '/api/v2.0/pool' }));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('tank');
    });

    it('throws UnsupportedExecError on non-JSON command when REST active', async () => {
      const fetchFn = makeFetch([() => ({ status: 200, body: {} })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      await expect(conn.exec('plain shell')).rejects.toBeInstanceOf(UnsupportedExecError);
    });

    it('routes shell strings through SSH when SSH is active (REST failed)', async () => {
      const fetchFn = makeFetch([() => ({ status: 502, body: '' })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const runner: SSHRunner = jest.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) // preflight
        .mockResolvedValueOnce({ stdout: 'truenas\n', stderr: '', exitCode: 0, timedOut: false });
      const ssh = new SSHClient({ runner });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      const r = await conn.exec('hostname');
      expect(r.stdout).toBe('truenas\n');
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('throws SSHAuthError when called before connect()', async () => {
      const fetchFn = makeFetch([() => ({ status: 200, body: {} })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await expect(conn.exec('whatever')).rejects.toBeInstanceOf(SSHAuthError);
    });
  });

  describe('disconnect()', () => {
    it('is idempotent on HTTPS transport', async () => {
      const fetchFn = makeFetch([() => ({ status: 200, body: {} })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
      expect(conn.isConnected()).toBe(false);
    });

    it('is idempotent on SSH transport', async () => {
      const fetchFn = makeFetch([() => ({ status: 500, body: '' })]);
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const ssh = new SSHClient({ runner: okRunner() });
      const conn = new TrueNasConnection('truenas-01', { ...baseOpts, httpsClient, sshClient: ssh });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
      expect(conn.isConnected()).toBe(false);
    });
  });
});
