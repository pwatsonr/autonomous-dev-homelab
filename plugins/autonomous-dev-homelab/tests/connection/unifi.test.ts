/**
 * Unit tests for `UnifiConnection`. Implements SPEC-001-2-05
 * §"Per-Subclass Unit Tests" for the UniFi (HTTPS-only) subclass.
 *
 * UniFi has no MCP/SSH path; the only transport is HTTPS, so tests cover:
 * - preflight success / failure on `connect()`,
 * - `exec(JSON)` success against the descriptor protocol,
 * - `exec('plain string')` throws `UnsupportedExecError`,
 * - `disconnect()` is a no-op.
 *
 * Mocks the `fetch` impl injected into `HTTPSClient`.
 */

import { UnifiConnection } from '../../src/connection/unifi';
import { SSHAuthError, UnsupportedExecError } from '../../src/connection/errors';
import { HTTPSClient, type FetchFn } from '../../src/connection/https-client';

function makeFetch(impl: (url: string, init?: RequestInit) => { status: number; body: unknown }): jest.MockedFunction<FetchFn> {
  const fn: FetchFn = async (url, init) => {
    const r = impl(url, init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return jest.fn(fn) as jest.MockedFunction<FetchFn>;
}

const baseOpts = {
  hostname: 'unifi.local',
  baseUrl: 'https://unifi.local:8443',
  bearerToken: 'tok',
};

describe('UnifiConnection', () => {
  describe('connect()', () => {
    it('marks https transport on preflight success', async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: { ok: true } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: baseOpts.bearerToken }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      expect(conn.isConnected()).toBe(true);
      expect(conn.getCapabilities()?.transport).toBe('https');
      expect(conn.getCapabilities()?.hostname).toBe('unifi.local');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('throws SSHAuthError when preflight returns non-2xx', async () => {
      const fetchFn = makeFetch(() => ({ status: 401, body: { error: 'denied' } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await expect(conn.connect()).rejects.toBeInstanceOf(SSHAuthError);
      expect(conn.isConnected()).toBe(false);
    });
  });

  describe('exec()', () => {
    it('routes JSON-descriptor commands as HTTPS requests', async () => {
      const seenInits: RequestInit[] = [];
      const fn: FetchFn = async (_url, init) => {
        void _url;
        if (init !== undefined) seenInits.push(init);
        const isPreflight = seenInits.length === 1;
        const body = isPreflight ? { ok: true } : { devices: ['ap-1', 'ap-2'] };
        return new Response(JSON.stringify(body), { status: 200 });
      };
      const fetchFn = jest.fn(fn) as jest.MockedFunction<FetchFn>;
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: baseOpts.bearerToken }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();

      const desc = JSON.stringify({ method: 'GET', path: '/api/s/default/stat/device' });
      const r = await conn.exec(desc);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ap-1');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      // Second call corresponds to exec; verify method.
      expect(seenInits[1]?.method).toBe('GET');
    });

    it('maps non-2xx HTTPS responses to non-zero exitCode without throwing', async () => {
      let call = 0;
      const fn: FetchFn = async (_url, _init) => {
        void _url;
        void _init;
        call += 1;
        if (call === 1) return new Response('{}', { status: 200 });
        return new Response(JSON.stringify({ error: 'gone' }), { status: 404 });
      };
      const fetchFn = jest.fn(fn) as jest.MockedFunction<FetchFn>;
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      const r = await conn.exec(JSON.stringify({ method: 'GET', path: '/missing' }));
      expect(r.exitCode).toBe(404);
    });

    it("throws UnsupportedExecError for non-JSON commands", async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: { ok: true } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      await expect(conn.exec('not json')).rejects.toBeInstanceOf(UnsupportedExecError);
    });

    it('throws UnsupportedExecError when descriptor missing required fields', async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: { ok: true } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      await expect(conn.exec(JSON.stringify({ path: '/foo' }))).rejects.toBeInstanceOf(UnsupportedExecError);
    });

    it('throws SSHAuthError when called before connect()', async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: {} }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await expect(conn.exec(JSON.stringify({ method: 'GET', path: '/x' }))).rejects.toBeInstanceOf(SSHAuthError);
    });
  });

  describe('disconnect()', () => {
    it('is a no-op (no SSH/MCP teardown) but flips isConnected()', async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: { ok: true } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: 'x' }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      await conn.disconnect();
      expect(conn.isConnected()).toBe(false);
      // Called once for preflight only — disconnect did not touch the wire.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('is idempotent', async () => {
      const fetchFn = makeFetch(() => ({ status: 200, body: { ok: true } }));
      const httpsClient = new HTTPSClient({ baseUrl: baseOpts.baseUrl, bearerToken: 'x' }, { fetch: fetchFn });
      const conn = new UnifiConnection('unifi-01', { ...baseOpts, httpsClient });
      await conn.connect();
      await conn.disconnect();
      await expect(conn.disconnect()).resolves.toBeUndefined();
    });
  });
});
