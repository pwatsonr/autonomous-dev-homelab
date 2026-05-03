/**
 * Unit tests for `AuditKeyStore`. SPEC-001-3-02 §"AuditKeyStore".
 *
 * Covers: first-call generation with mode 0600; subsequent calls reuse;
 * mode-mismatch warning; corrupt-key rejection; cache invalidation.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditKeyStore } from '../../src/audit/key-store';
import { InvalidAuditKeyError } from '../../src/audit/types';

async function tempDir(prefix = 'audit-key-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('AuditKeyStore', () => {
  it('generates a fresh 32-byte key on first call and persists with mode 0600', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    const store = new AuditKeyStore({ keyPath });

    const key = await store.getKey();
    expect(key.length).toBe(32);

    const raw = await fs.readFile(keyPath, 'utf8');
    expect(raw).toMatch(/^[0-9a-f]{64}\n$/);
    const stat = await fs.stat(keyPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reuses the persisted key on subsequent calls', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    const a = new AuditKeyStore({ keyPath });
    const k1 = await a.getKey();

    const b = new AuditKeyStore({ keyPath });
    const k2 = await b.getKey();
    expect(k2.equals(k1)).toBe(true);
  });

  it('returns the cached key without re-reading disk after first call', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    const store = new AuditKeyStore({ keyPath });
    const k1 = await store.getKey();
    // Delete file: a re-read would fail; cache means it does not.
    await fs.unlink(keyPath);
    const k2 = await store.getKey();
    expect(k2.equals(k1)).toBe(true);
  });

  it('rejects a key file that is not 64 hex chars', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    await fs.writeFile(keyPath, 'not-hex\n');
    const store = new AuditKeyStore({ keyPath });
    await expect(store.getKey()).rejects.toBeInstanceOf(InvalidAuditKeyError);
  });

  it('logs a warning if the existing key file mode is not 0600', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    // Write with mode 0644.
    await fs.writeFile(keyPath, 'a'.repeat(64) + '\n');
    await fs.chmod(keyPath, 0o644);
    const warnings: string[] = [];
    const store = new AuditKeyStore({
      keyPath,
      logger: { warn: (msg): void => { warnings.push(msg); } },
    });
    await store.getKey();
    expect(warnings.some((m) => m.includes('mode is 644'))).toBe(true);
  });

  it('keyFileExists is false until generation', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    const store = new AuditKeyStore({ keyPath });
    expect(await store.keyFileExists()).toBe(false);
    await store.getKey();
    expect(await store.keyFileExists()).toBe(true);
  });

  it('clearCache forces a disk re-read on next getKey', async () => {
    const dir = await tempDir();
    const keyPath = path.join(dir, '.audit-key');
    const store = new AuditKeyStore({ keyPath });
    const k1 = await store.getKey();
    store.clearCache();
    // Overwrite with a new key value.
    const fresh = 'b'.repeat(64);
    await fs.writeFile(keyPath, fresh + '\n');
    await fs.chmod(keyPath, 0o600);
    const k2 = await store.getKey();
    expect(k2.toString('hex')).toBe(fresh);
    expect(k2.equals(k1)).toBe(false);
  });
});
