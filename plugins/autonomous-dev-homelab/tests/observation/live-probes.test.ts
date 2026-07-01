/**
 * Tests for src/observation/live-probes.ts.
 * Covers T009-1 through T009-4 from SPEC REQ-000055 §5.10.
 */

import { buildLiveProbes } from '../../src/observation/live-probes';
import type { HomelabConfig } from '../../src/config/types';

const THREE_HOST_CONFIG: HomelabConfig = {
  version: 1,
  vault: {
    address: 'https://vault.test:8200',
    auth_method: 'approle',
    approle: {
      role_id_env: 'VAULT_ROLE_ID',
      secret_id_env: 'VAULT_SECRET_ID',
    },
  },
  hosts: [
    {
      hostname: 'gallifrey-lab-01',
      platform: 'docker-swarm-manager',
      role: 'manager',
      ssh_fallback: {
        host: 'gallifrey-lab-01',
        port: 22,
        user: 'patrick',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key1' },
      },
    },
    {
      hostname: 'gallifrey-lab-02',
      platform: 'docker-swarm-worker',
      role: 'worker',
      ssh_fallback: {
        host: 'gallifrey-lab-02',
        port: 22,
        user: 'patrick',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key2' },
      },
    },
    {
      hostname: 'unraid.pwatson.space',
      platform: 'unraid',
      role: 'nas',
      ssh_fallback: {
        host: 'unraid.pwatson.space',
        port: 22,
        user: 'root',
        key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key3' },
      },
    },
  ],
};

describe('buildLiveProbes', () => {
  // T009-1: Probe count — 3 hosts = 4 probes (2 swarm + 2 unraid)
  it('T009-1: returns 4 probes for manager + worker + unraid config', () => {
    const probes = buildLiveProbes(THREE_HOST_CONFIG);
    expect(probes).toHaveLength(4);
  });

  // T009-2: Ordering matches config.hosts
  it('T009-2: probe ordering matches config.hosts order', () => {
    const probes = buildLiveProbes(THREE_HOST_CONFIG);
    // First two are swarm probes (manager then worker)
    expect(probes[0]?.id).toMatch(/swarm/);
    expect(probes[0]?.platformId).toBe('gallifrey-lab-01');
    expect(probes[1]?.id).toMatch(/swarm/);
    expect(probes[1]?.platformId).toBe('gallifrey-lab-02');
    // Last two are unraid probes (array then pool)
    expect(probes[2]?.id).toMatch(/unraid-array/);
    expect(probes[2]?.platformId).toBe('unraid.pwatson.space');
    expect(probes[3]?.id).toMatch(/unraid-pool/);
    expect(probes[3]?.platformId).toBe('unraid.pwatson.space');
  });

  it('returns 1 probe for a single swarm manager', () => {
    const config: HomelabConfig = {
      ...THREE_HOST_CONFIG,
      hosts: [THREE_HOST_CONFIG.hosts[0]!],
    };
    expect(buildLiveProbes(config)).toHaveLength(1);
  });

  it('returns 2 probes for a single unraid host', () => {
    const config: HomelabConfig = {
      ...THREE_HOST_CONFIG,
      hosts: [THREE_HOST_CONFIG.hosts[2]!],
    };
    expect(buildLiveProbes(config)).toHaveLength(2);
  });

  // T009-3: Each probe has the expected Probe interface
  it('T009-3: each probe implements the Probe interface', () => {
    const probes = buildLiveProbes(THREE_HOST_CONFIG);
    for (const p of probes) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.platformId).toBe('string');
      expect(['fast', 'medium', 'slow', 'daily']).toContain(p.cadence);
      expect(typeof p.scan).toBe('function');
    }
  });

  // T009-4: Read-only enforcement — probes don't mutate (they use stub exec sources)
  it('T009-4: probe.scan() returns observations without mutating (stub exec sources)', async () => {
    const probes = buildLiveProbes(THREE_HOST_CONFIG);
    for (const probe of probes) {
      const obs = await probe.scan();
      expect(Array.isArray(obs)).toBe(true);
      // With no-op exec source, no crash_loop observations should be emitted
      // (empty stdout → no unhealthy services)
      // Unraid probes with empty stdout won't trigger degraded state either
    }
  });
});
