/**
 * Tests for src/config/loader.ts — config load + validation.
 * Covers T004-1 through T004-8 from SPEC REQ-000055 §5.4.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { loadHomelabConfig, assertNoInlineSecrets } from '../../src/config/loader';
import { ConfigInvalidError, ConfigNotFoundError } from '../../src/config/errors';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('loadHomelabConfig', () => {
  // T004-1: Valid fixture parses
  it('parses valid.yaml and returns typed config', async () => {
    const config = await loadHomelabConfig({ path: path.join(FIXTURES, 'valid.yaml') });
    expect(config.version).toBe(1);
    expect(config.vault.address).toBe('https://vault.pwatson.space:8200');
    expect(config.vault.auth_method).toBe('approle');
    expect(config.vault.approle?.role_id_env).toBe('VAULT_ROLE_ID');
    expect(config.hosts).toHaveLength(3);
    expect(config.hosts[0]?.hostname).toBe('gallifrey-lab-01');
    expect(config.hosts[0]?.platform).toBe('docker-swarm-manager');
    expect(config.hosts[0]?.role).toBe('manager');
    expect(config.hosts[2]?.platform).toBe('unraid');
    expect(config.hosts[2]?.role).toBe('nas');
  });

  // T004-2: Inline secret rejected
  it('rejects invalid-inline-secret.yaml with ConfigInvalidError', async () => {
    await expect(
      loadHomelabConfig({ path: path.join(FIXTURES, 'invalid-inline-secret.yaml') }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      exit: 11,
    });
  });

  it('inline secret error mentions the disallowed key', async () => {
    try {
      await loadHomelabConfig({ path: path.join(FIXTURES, 'invalid-inline-secret.yaml') });
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigInvalidError);
      expect((err as ConfigInvalidError).message).toMatch(/value|inline secret/i);
    }
  });

  // T004-3: Missing vault rejected
  it('rejects invalid-missing-vault.yaml with ConfigInvalidError mentioning vault/Required', async () => {
    try {
      await loadHomelabConfig({ path: path.join(FIXTURES, 'invalid-missing-vault.yaml') });
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigInvalidError);
      expect((err as ConfigInvalidError).message).toMatch(/vault|Required/i);
    }
  });

  // T004-4: Bad port rejected
  it('rejects invalid-bad-cidr.yaml with error mentioning port range', async () => {
    try {
      await loadHomelabConfig({ path: path.join(FIXTURES, 'invalid-bad-cidr.yaml') });
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigInvalidError);
      expect((err as ConfigInvalidError).message).toMatch(/65535|port/i);
    }
  });

  // T004-5: Unknown key rejected
  it('rejects configs with unknown keys', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-test-'));
    const cfgPath = path.join(tmp, 'cfg.yaml');
    const yaml = `
version: 1
vault:
  address: https://vault.pwatson.space:8200
  auth_method: approle
  approle:
    role_id_env: VAULT_ROLE_ID
    secret_id_env: VAULT_SECRET_ID
hosts:
  - hostname: gallifrey-lab-01
    platform: docker-swarm-manager
    role: manager
    bogus: 1
    ssh_fallback:
      host: gallifrey-lab-01
      port: 22
      user: patrick
      key_ref:
        vault_path: kv/data/homelab/ssh
        vault_field: gallifrey_key
`.trimStart();
    await fs.writeFile(cfgPath, yaml, 'utf8');
    try {
      await expect(loadHomelabConfig({ path: cfgPath })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // T004-6: Env path resolution
  it('reads config from env var AUTONOMOUS_DEV_HOMELAB_CONFIG', async () => {
    const validPath = path.join(FIXTURES, 'valid.yaml');
    const config = await loadHomelabConfig({
      env: { AUTONOMOUS_DEV_HOMELAB_CONFIG: validPath },
    });
    expect(config.version).toBe(1);
  });

  // T004-7: Missing file → ConfigNotFoundError
  it('throws ConfigNotFoundError for nonexistent path', async () => {
    await expect(
      loadHomelabConfig({ path: '/nonexistent/path/homelab.config.yaml' }),
    ).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
      exit: 12,
    });
  });
});

describe('assertNoInlineSecrets', () => {
  it('passes clean objects', () => {
    expect(() =>
      assertNoInlineSecrets({
        vault_path: 'kv/data/x',
        vault_field: 'key',
      }),
    ).not.toThrow();
  });

  it('throws on disallowed leaf key "value"', () => {
    expect(() =>
      assertNoInlineSecrets({
        key_ref: {
          vault_path: 'kv/data/x',
          vault_field: 'key',
          value: 'secret-material',
        },
      }),
    ).toThrow(ConfigInvalidError);
  });

  it('throws on disallowed leaf key "password"', () => {
    expect(() =>
      assertNoInlineSecrets({ password: 'hunter2' }),
    ).toThrow(ConfigInvalidError);
  });

  it('passes objects with vault_path and vault_field only', () => {
    expect(() =>
      assertNoInlineSecrets({ vault_path: 'kv/data/x', vault_field: 'y' }),
    ).not.toThrow();
  });
});
