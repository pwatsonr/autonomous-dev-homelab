/**
 * Unit tests for the Vault secret-tree structure adapter (issue #29).
 *
 * Tests:
 * - Vault LIST response → secret-ref entities (structure only)
 * - Recursive directory listing
 * - member-of edges from secret-ref → Vault entity
 * - Structure-only proof: HTTP method is always LIST, never GET on data paths
 * - Graceful degradation: no Vault entity in graph
 * - Graceful degradation: no VAULT_TOKEN
 * - Graceful degradation: Vault API unreachable
 * - deriveVaultAddress: explicit vault_addr, VAULT_ADDR env, host-based
 * - extractKvMounts: string, array, default
 *
 * All HTTP calls use injected fetchImpl — no live network calls.
 */

import {
  VaultAdapter,
  VaultAdapterOptions,
  deriveVaultAddress,
  extractKvMounts,
  VaultListResponse,
} from '../../../src/discovery/topology/vault-adapter';
import type { Entity } from '../../../src/discovery/graph-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-01-15T00:00:00.000Z';

function makeEntity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    kind: 'service',
    attributes: {},
    source: 'test',
    discovered_at: NOW,
    last_seen: NOW,
    status: 'active',
    ...overrides,
  };
}

function makeGraphStore(opts: { services?: Entity[] }): import('../../../src/discovery/graph-store').GraphStore {
  const services = opts.services ?? [];
  return {
    entitiesByKind: jest.fn().mockImplementation((kind: string) => {
      if (kind === 'service') return Promise.resolve(services);
      return Promise.resolve([]);
    }),
    upsertEntity: jest.fn().mockResolvedValue(undefined),
    upsertEdge: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('../../../src/discovery/graph-store').GraphStore;
}

/** Build a fetch mock that returns a Vault LIST response. */
function makeFetchList(response: VaultListResponse) {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(response),
  });
}

/**
 * Build a multi-response fetch mock that returns different responses for
 * different URLs. Keys are URL suffixes that the requested URL must END WITH
 * (after the base address) to be precise about path matching.
 */
function makeFetchMulti(responses: Array<[string, VaultListResponse | null, number]>) {
  return jest.fn().mockImplementation((url: string) => {
    // Sort by descending suffix length so more-specific patterns win.
    const sorted = [...responses].sort(([a], [b]) => b.length - a.length);
    for (const [suffix, body, status] of sorted) {
      if (url.endsWith(suffix)) {
        if (status === 404 || body === null) {
          return Promise.resolve({ ok: false, status: 404, json: jest.fn().mockResolvedValue({}) });
        }
        return Promise.resolve({
          ok: true,
          status,
          json: jest.fn().mockResolvedValue(body),
        });
      }
    }
    return Promise.resolve({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ data: { keys: [] } }) });
  });
}

function makeAdapter(
  graphStore: ReturnType<typeof makeGraphStore>,
  env: NodeJS.ProcessEnv,
  opts: VaultAdapterOptions = {},
): VaultAdapter {
  return new VaultAdapter(graphStore as never, env, { clock: () => NOW, ...opts });
}

// ---------------------------------------------------------------------------
// deriveVaultAddress
// ---------------------------------------------------------------------------

describe('deriveVaultAddress', () => {
  it('returns vault_addr attribute when set', () => {
    const e = makeEntity({
      id: 'svc:vault',
      name: 'vault',
      attributes: { vault_addr: 'https://vault.example.com:8200/' },
    });
    expect(deriveVaultAddress(e, {})).toBe('https://vault.example.com:8200');
  });

  it('returns VAULT_ADDR env var when set', () => {
    const e = makeEntity({ id: 'svc:vault', name: 'vault', attributes: {} });
    expect(deriveVaultAddress(e, { VAULT_ADDR: 'http://10.0.0.1:8200' })).toBe(
      'http://10.0.0.1:8200',
    );
  });

  it('builds URL from host attribute with default port 8200', () => {
    const e = makeEntity({
      id: 'svc:vault',
      name: 'vault',
      attributes: { host: '10.0.0.1' },
    });
    expect(deriveVaultAddress(e, {})).toBe('http://10.0.0.1:8200');
  });

  it('returns null when no usable info is present', () => {
    const e = makeEntity({ id: 'svc:vault', name: 'vault', attributes: {} });
    expect(deriveVaultAddress(e, {})).toBeNull();
  });

  it('prefers vault_addr attribute over VAULT_ADDR env', () => {
    const e = makeEntity({
      id: 'svc:vault',
      name: 'vault',
      attributes: { vault_addr: 'https://from-attr:8200' },
    });
    expect(deriveVaultAddress(e, { VAULT_ADDR: 'https://from-env:8200' })).toBe(
      'https://from-attr:8200',
    );
  });
});

// ---------------------------------------------------------------------------
// extractKvMounts
// ---------------------------------------------------------------------------

describe('extractKvMounts', () => {
  it('returns default ["secret"] when no kv_mounts attribute', () => {
    const e = makeEntity({ id: 'v', name: 'vault', attributes: {} });
    expect(extractKvMounts(e)).toEqual(['secret']);
  });

  it('parses comma-separated string', () => {
    const e = makeEntity({
      id: 'v',
      name: 'vault',
      attributes: { kv_mounts: 'secret, kv, homelab' },
    });
    expect(extractKvMounts(e)).toEqual(['secret', 'kv', 'homelab']);
  });

  it('accepts array attribute', () => {
    const e = makeEntity({
      id: 'v',
      name: 'vault',
      attributes: { kv_mounts: ['secret', 'ops'] },
    });
    expect(extractKvMounts(e)).toEqual(['secret', 'ops']);
  });
});

// ---------------------------------------------------------------------------
// VaultAdapter.discover — no Vault entity in graph
// ---------------------------------------------------------------------------

describe('VaultAdapter: no vault entity', () => {
  it('returns empty result without degraded flag when graph has no secrets-role entity', async () => {
    const graphStore = makeGraphStore({ services: [] });
    const adapter = makeAdapter(graphStore, {});
    const result = await adapter.discover();

    expect(result.degraded).toBe(false);
    expect(result.entities).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.keyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VaultAdapter.discover — no VAULT_TOKEN
// ---------------------------------------------------------------------------

describe('VaultAdapter: no token', () => {
  it('returns degraded result when VAULT_TOKEN is not set', async () => {
    const vaultEntity = makeEntity({
      id: 'svc:vault',
      name: 'vault',
      attributes: { role: 'secrets', host: '10.0.0.2' },
    });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(graphStore, {}); // no VAULT_TOKEN

    const result = await adapter.discover();

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toContain('VAULT_TOKEN');
    expect(result.entities).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VaultAdapter.discover — Vault unreachable (network error)
// ---------------------------------------------------------------------------

describe('VaultAdapter: graceful degradation on network error', () => {
  it('returns empty result (not full degradation) when individual mount LIST fails', async () => {
    const vaultEntity = makeEntity({
      id: 'svc:vault',
      name: 'vault',
      attributes: { role: 'secrets', host: '10.0.0.2' },
    });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const adapter = makeAdapter(graphStore, { VAULT_TOKEN: 'root' }, { fetchImpl });

    // When mount-level listing fails, adapter gracefully skips that mount
    // but does NOT set overall degraded (only per-mount errors, not fatal).
    const result = await adapter.discover();

    // Overall pass is not degraded (mount errors are non-fatal).
    expect(result.degraded).toBe(false);
    expect(result.entities).toHaveLength(0);
    expect(result.keyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VaultAdapter.discover — sample LIST response → secret-ref entities
// ---------------------------------------------------------------------------

describe('VaultAdapter: sample LIST response → secret-ref entities', () => {
  const vaultEntity = makeEntity({
    id: 'svc:vault',
    name: 'vault',
    attributes: { role: 'secrets', host: '10.0.0.2' },
  });

  const listResponse: VaultListResponse = {
    data: {
      keys: ['homelab/', 'prod-db-password', 'api-key'],
    },
  };

  const subListResponse: VaultListResponse = {
    data: {
      keys: ['npm-token', 'grafana-admin'],
    },
  };

  it('emits secret-ref entities for each leaf key', async () => {
    const fetchImpl = makeFetchMulti([
      // More-specific suffix (with subdirectory) must come before generic root.
      ['/metadata/homelab/', subListResponse, 200],
      ['/metadata/', listResponse, 200],
    ]);
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();

    // Leaf keys: prod-db-password, api-key (from root), npm-token, grafana-admin (from homelab/)
    // Directory marker 'homelab/' itself should NOT create a leaf entity
    const leafPaths = result.entities.map((e) => e.attributes['path'] as string);
    expect(leafPaths).toContain('secret/prod-db-password');
    expect(leafPaths).toContain('secret/api-key');
    expect(leafPaths).toContain('secret/homelab/npm-token');
    expect(leafPaths).toContain('secret/homelab/grafana-admin');
    expect(leafPaths.some((p) => p.endsWith('homelab/'))).toBe(false);
  });

  it('sets kind=secret-ref for every entity', async () => {
    const fetchImpl = makeFetchList(listResponse);
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();
    for (const e of result.entities) {
      expect(e.kind).toBe('secret-ref');
    }
  });

  it('emits member-of edge from secret-ref to Vault entity', async () => {
    const fetchImpl = makeFetchList({ data: { keys: ['my-secret'] } });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.type).toBe('member-of');
    expect(result.edges[0]!.to).toBe(vaultEntity.id);
    expect(result.edges[0]!.from).toContain('secret-ref:vault:');
  });

  it('NEVER sets a value attribute on secret-ref entities (structure-only proof)', async () => {
    const fetchImpl = makeFetchList({ data: { keys: ['my-secret'] } });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();

    for (const e of result.entities) {
      expect(e.attributes).not.toHaveProperty('value');
      expect(e.attributes).not.toHaveProperty('secret_value');
      expect(e.attributes).not.toHaveProperty('data');
    }
  });

  it('ONLY uses LIST method — never GET on data paths (structure-only proof)', async () => {
    const fetchImpl = makeFetchList({ data: { keys: ['mykey'] } });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    await adapter.discover();

    const calls = (fetchImpl as jest.Mock).mock.calls as Array<[string, RequestInit]>;
    for (const [url, init] of calls) {
      // All calls must use LIST method.
      expect(init.method).toBe('LIST');
      // URL must be a metadata path (not data path).
      expect(url).toContain('/metadata/');
      expect(url).not.toContain('/data/');
    }
  });

  it('sends the Vault token in X-Vault-Token header', async () => {
    const fetchImpl = makeFetchList({ data: { keys: [] } });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'my-vault-token', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    await adapter.discover();

    const calls = (fetchImpl as jest.Mock).mock.calls as Array<[string, RequestInit]>;
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>)['X-Vault-Token']).toBe('my-vault-token');
    }
  });

  it('treats 404 response from LIST as empty (path does not exist yet)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: jest.fn().mockResolvedValue({}),
    });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();

    expect(result.degraded).toBe(false);
    expect(result.entities).toHaveLength(0);
    expect(result.keyCount).toBe(0);
  });

  it('source attribute is vault on all entities', async () => {
    const fetchImpl = makeFetchList({ data: { keys: ['k1', 'k2'] } });
    const graphStore = makeGraphStore({ services: [vaultEntity] });
    const adapter = makeAdapter(
      graphStore,
      { VAULT_TOKEN: 'root', VAULT_ADDR: 'http://vault:8200' },
      { fetchImpl },
    );
    const result = await adapter.discover();
    for (const e of result.entities) {
      expect(e.source).toBe('vault');
    }
  });
});
