/**
 * GAP 1 wiring test: verifies that the observe CLI path builds non-empty
 * live probes from a config with hosts, and that probes are wired to a
 * real pool-backed exec source.
 *
 * Tests the `buildLiveProbes` + pool-injection path directly (rather than
 * spawning the full CLI), because the full CLI loads config from disk and
 * pings Vault — both undesirable in unit tests.
 */

import { buildLiveProbes } from '../../src/observation/live-probes';
import { ObservationCollector } from '../../src/observation/collector';
import { DedupCache } from '../../src/observation/dedup';
import { ObservationStore } from '../../src/observation/persistence';
import { ObservationPromoter } from '../../src/observation/promoter';
import type { HomelabConfig } from '../../src/config/types';
import type { ConnectionPool } from '../../src/connection/pool';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

/** Minimal homelab config with two swarm hosts and one unraid host. */
const CONFIG_WITH_HOSTS: HomelabConfig = {
  version: 1,
  vault: {
    address: 'https://vault.test:8200',
    auth_method: 'approle',
    approle: { role_id_env: 'VAULT_ROLE_ID', secret_id_env: 'VAULT_SECRET_ID' },
  },
  hosts: [
    {
      hostname: 'swarm-manager-01',
      platform: 'docker-swarm-manager',
      role: 'manager',
      ssh_fallback: {
        host: 'swarm-manager-01',
        port: 22,
        user: 'ops',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key1' },
      },
    },
    {
      hostname: 'nas-01',
      platform: 'unraid',
      role: 'nas',
      ssh_fallback: {
        host: 'nas-01',
        port: 22,
        user: 'root',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key2' },
      },
    },
  ],
};

/** Minimal homelab config with no hosts (empty list). */
const CONFIG_NO_HOSTS: HomelabConfig = {
  ...CONFIG_WITH_HOSTS,
  hosts: [],
};

/**
 * Build a pool mock that records exec invocations per platform.
 */
function makePoolMock(stdout = ''): {
  pool: ConnectionPool;
  calls: Array<{ platformId: string; command: string }>;
} {
  const calls: Array<{ platformId: string; command: string }> = [];
  const pool = {
    getConnection: jest.fn(async (platformId: string) => ({
      exec: jest.fn(async (command: string) => {
        calls.push({ platformId, command });
        return { stdout, stderr: '', exitCode: 0, durationMs: 1 };
      }),
    })),
  } as unknown as ConnectionPool;
  return { pool, calls };
}

describe('observe CLI — live probe wiring (GAP 1)', () => {
  it('buildLiveProbes returns non-empty probes for a config with hosts', () => {
    const probes = buildLiveProbes(CONFIG_WITH_HOSTS);
    // 1 swarm-manager → 1 swarm probe; 1 unraid → 2 probes
    expect(probes.length).toBeGreaterThan(0);
    expect(probes).toHaveLength(3);
  });

  it('buildLiveProbes returns empty list for a config with no hosts', () => {
    const probes = buildLiveProbes(CONFIG_NO_HOSTS);
    expect(probes).toHaveLength(0);
  });

  it('probes built with pool exec real commands through the pool connection', async () => {
    const { pool, calls } = makePoolMock('');
    const probes = buildLiveProbes(CONFIG_WITH_HOSTS, { pool });
    expect(probes).toHaveLength(3);

    // Run all probes; each should delegate exec to pool.getConnection
    for (const p of probes) {
      await p.scan();
    }
    // 1 swarm probe + 2 unraid probes = 3 exec calls
    expect(calls).toHaveLength(3);
    // Swarm probe targets swarm-manager-01
    expect(calls.find((c) => c.platformId === 'swarm-manager-01')).toBeDefined();
    // Unraid probes target nas-01
    const nasCalls = calls.filter((c) => c.platformId === 'nas-01');
    expect(nasCalls).toHaveLength(2);
  });

  it('ObservationCollector built with live probes calls pool on scan', async () => {
    const dataDir = await mkTempDir('observe-wiring-');
    try {
      const { pool, calls } = makePoolMock('');
      const probes = buildLiveProbes(CONFIG_WITH_HOSTS, { pool });
      const store = new ObservationStore(dataDir);
      const dedup = new DedupCache();
      const promoter = new ObservationPromoter({
        execFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      });
      const collector = new ObservationCollector({ probes, dedup, store, promoter });

      await collector.runAll();
      // All 3 probes executed → 3 exec calls routed through pool
      expect(calls).toHaveLength(3);
    } finally {
      await rmTempDir(dataDir);
    }
  });
});
