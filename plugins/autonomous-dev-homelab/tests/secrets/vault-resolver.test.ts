/**
 * Tests for src/secrets/vault-resolver.ts.
 * Covers T005a-1 through T005a-11 from SPEC REQ-000055 §5.5.
 *
 * All tests use a mock fetch; no real network connections are made.
 */

import * as crypto from 'node:crypto';
import { VaultSecretResolver } from '../../src/secrets/vault-resolver';
import {
  VaultUnreachableError,
  VaultAuthError,
  VaultPermissionError,
  SecretMissingError,
} from '../../src/secrets/errors';
import type { VaultConfig } from '../../src/config/types';

const BASE_CFG: VaultConfig = {
  address: 'https://vault.test:8200',
  auth_method: 'approle',
  approle: {
    role_id_env: 'VAULT_ROLE_ID',
    secret_id_env: 'VAULT_SECRET_ID',
  },
};

const TEST_ENV = {
  VAULT_ROLE_ID: 'test-role-id',
  VAULT_SECRET_ID: 'test-secret-id',
};

function makeLoginResponse(token = 'test-token', leaseDuration = 60): Response {
  return new Response(
    JSON.stringify({
      auth: { client_token: token, lease_duration: leaseDuration },
    }),
    { status: 200 },
  );
}

function makeKVResponse(data: Record<string, string>, version = 1): Response {
  return new Response(
    JSON.stringify({
      data: { data, metadata: { version } },
    }),
    { status: 200 },
  );
}

function computeExpectedHash(vaultPath: string, vaultField: string, version: number): string {
  const material = `vault:${vaultPath}:${vaultField}:${version}`;
  const hash = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

describe('VaultSecretResolver', () => {
  // T005a-1: Happy path resolve
  it('T005a-1: resolves a secret and returns correct value + refHash', async () => {
    let callCount = 0;
    const fetchImpl = jest.fn(async (url: string) => {
      callCount++;
      if (url.includes('/v1/auth/approle/login')) {
        return makeLoginResponse();
      }
      return makeKVResponse({ key: 'value' }, 3);
    });

    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });

    expect(result.value.equals(Buffer.from('value', 'utf8'))).toBe(true);
    expect(result.refHash).toBe(computeExpectedHash('kv/data/x', 'key', 3));
    expect(result.ref).toEqual({ vault_path: 'kv/data/x', vault_field: 'key' });
  });

  // T005a-2: refHash determinism
  it('T005a-2: refHash is deterministic across calls', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/v1/auth/approle/login')) return makeLoginResponse();
      return makeKVResponse({ key: 'value' }, 3);
    });

    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r1 = await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });
    const r2 = await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });

    expect(r1.refHash).toBe(r2.refHash);
  });

  // T005a-3: Token cache — only 1 login within TTL
  it('T005a-3: caches token within TTL (only 1 login for 5 resolves)', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/v1/auth/approle/login')) return makeLoginResponse('t', 3600);
      return makeKVResponse({ key: 'v' }, 1);
    });

    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    for (let i = 0; i < 5; i++) {
      await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });
    }

    const loginCalls = (fetchImpl.mock.calls as string[][]).filter(([url]) =>
      url.includes('/v1/auth/approle/login'),
    );
    expect(loginCalls).toHaveLength(1);
  });

  // T005a-4: Token refresh at 90% of TTL
  it('T005a-4: refreshes token after TTL*0.9 elapses', async () => {
    let now = 0;
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/v1/auth/approle/login')) return makeLoginResponse('t', 100); // 100s lease
      return makeKVResponse({ key: 'v' }, 1);
    });

    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      tokenRefreshRatio: 0.9,
    });

    // First resolve: login + kv
    await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });
    const loginCallsBefore = (fetchImpl.mock.calls as string[][]).filter(([url]) =>
      url.includes('/v1/auth/approle/login'),
    ).length;
    expect(loginCallsBefore).toBe(1);

    // Advance clock past 90% of 100s = 90s
    now = 91 * 1000;

    // Second resolve: should trigger re-login
    await resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' });
    const loginCallsAfter = (fetchImpl.mock.calls as string[][]).filter(([url]) =>
      url.includes('/v1/auth/approle/login'),
    ).length;
    expect(loginCallsAfter).toBe(2);
  });

  // T005a-5: ping 200
  it('T005a-5: ping() resolves on HTTP 200', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.ping()).resolves.toBeUndefined();
  });

  // T005a-6: ping 429 (reachable standby)
  it('T005a-6: ping() resolves on HTTP 429', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 429 }));
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.ping()).resolves.toBeUndefined();
  });

  // T005a-7: ping connect refuse
  it('T005a-7: ping() throws VaultUnreachableError on ECONNREFUSED', async () => {
    const fetchImpl = jest.fn(async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.ping()).rejects.toMatchObject({
      code: 'VAULT_UNREACHABLE',
      exit: 20,
    });
  });

  // T005a-8: Login 400 → VaultAuthError
  it('T005a-8: resolve() throws VaultAuthError on login 400', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 400 }));
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' })).rejects.toMatchObject({
      code: 'VAULT_AUTH_FAILED',
      exit: 21,
    });
  });

  // T005a-9: KV 403 → VaultPermissionError
  it('T005a-9: resolve() throws VaultPermissionError on KV 403', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/v1/auth/approle/login')) return makeLoginResponse();
      return new Response('{}', { status: 403 });
    });
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' })).rejects.toMatchObject({
      code: 'VAULT_PERMISSION',
      exit: 22,
    });
  });

  // T005a-10: Field missing → SecretMissingError
  it('T005a-10: resolve() throws SecretMissingError when field absent', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('/v1/auth/approle/login')) return makeLoginResponse();
      return makeKVResponse({ other: 'x' }, 1);
    });
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' })).rejects.toMatchObject({
      code: 'SECRET_MISSING',
      exit: 23,
    });
  });

  // T005a-11: Timeout → VaultUnreachableError
  it('T005a-11: resolve() throws VaultUnreachableError on timeout', async () => {
    const fetchImpl = jest.fn(async () => new Promise<Response>(() => { /* never resolves */ }));
    const resolver = new VaultSecretResolver(BASE_CFG, TEST_ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 50,
    });
    await expect(
      resolver.resolve({ vault_path: 'kv/data/x', vault_field: 'key' }),
    ).rejects.toMatchObject({
      code: 'VAULT_UNREACHABLE',
      exit: 20,
    });
  }, 500);
});
