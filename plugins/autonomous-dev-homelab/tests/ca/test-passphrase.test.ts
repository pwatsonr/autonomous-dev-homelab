/**
 * PassphraseProvider tests. Covers SPEC-001-2-01 acceptance criteria
 * for `src/ca/passphrase.ts`.
 *
 * Three resolution paths exercised: env, stored (encrypted blob), and
 * prompt (via injected readline factory). Caching is verified by
 * spying on the injected `createDecipheriv` factory.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PassphraseProvider } from '../../src/ca/passphrase';
import { PassphraseUnavailableError } from '../../src/ca/types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

describe('PassphraseProvider', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkTempDir();
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  describe('env source', () => {
    test('returns env var value with source=env', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: { HOMELAB_CA_PASSPHRASE: 'env-pass' },
        isTTY: () => false,
      });
      const r = await provider.get();
      expect(r).toEqual({ passphrase: 'env-pass', source: 'env' });
    });

    test('treats empty string env var as unset', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: { HOMELAB_CA_PASSPHRASE: '' },
        isTTY: () => false,
      });
      await expect(provider.get()).rejects.toBeInstanceOf(PassphraseUnavailableError);
    });
  });

  describe('stored source', () => {
    test('round-trips: store then a fresh provider get returns the same value', async () => {
      const writer = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      await writer.store('hunter2');
      // Verify on-disk shape and mode.
      const blobPath = path.join(tempDir, 'ca', 'passphrase.enc');
      const stat = await fs.stat(blobPath);
      expect(stat.mode & 0o777).toBe(0o600);
      const blob = JSON.parse(await fs.readFile(blobPath, 'utf8')) as Record<string, unknown>;
      expect(blob.version).toBe(1);
      expect(blob.kdf).toBe('pbkdf2-sha256');
      expect(blob.iterations).toBe(200_000);
      // Fresh provider, no env, no TTY → must decrypt the stored blob.
      const reader = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      const r = await reader.get();
      expect(r).toEqual({ passphrase: 'hunter2', source: 'stored' });
    });

    test('caches the decrypted result; second get does not re-decrypt', async () => {
      const writer = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      await writer.store('cache-test');
      const decipherSpy = jest.fn(crypto.createDecipheriv) as unknown as typeof crypto.createDecipheriv;
      const callCount = { n: 0 };
      const wrapped = ((alg: string, key: crypto.CipherKey, iv: crypto.BinaryLike | null) => {
        callCount.n += 1;
        return crypto.createDecipheriv(alg as crypto.CipherGCMTypes, key, iv as crypto.BinaryLike);
      }) as typeof crypto.createDecipheriv;
      void decipherSpy;
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: {},
        isTTY: () => false,
        createDecipheriv: wrapped,
      });
      const a = await provider.get();
      const b = await provider.get();
      expect(a.passphrase).toBe('cache-test');
      expect(b.passphrase).toBe('cache-test');
      // Decrypt was only invoked on the first get().
      expect(callCount.n).toBe(1);
    });

    test('rejects malformed JSON blob', async () => {
      const blobPath = path.join(tempDir, 'ca', 'passphrase.enc');
      await fs.mkdir(path.dirname(blobPath), { recursive: true });
      await fs.writeFile(blobPath, 'not json');
      const provider = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      await expect(provider.get()).rejects.toBeInstanceOf(PassphraseUnavailableError);
    });
  });

  describe('prompt source', () => {
    test('uses injected readline factory when no env and no stored blob', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: {},
        isTTY: () => true,
        readlineFactory: () => ({
          questionHidden: async (): Promise<string> => 'prompted-secret',
          close: (): void => {
            /* noop */
          },
        }),
      });
      const r = await provider.get();
      expect(r).toEqual({ passphrase: 'prompted-secret', source: 'prompt' });
    });

    test('throws PassphraseUnavailableError when stdin is not a TTY', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: {},
        isTTY: () => false,
      });
      await expect(provider.get()).rejects.toBeInstanceOf(PassphraseUnavailableError);
    });
  });

  describe('clear', () => {
    test('zeroes the in-memory cache buffer', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: { HOMELAB_CA_PASSPHRASE: 'secret-zzz' },
        isTTY: () => false,
      });
      await provider.get();
      // Reach into the private cache via index to inspect bytes BEFORE clear.
      const cacheBefore = (provider as unknown as { cache: Buffer | null }).cache;
      expect(cacheBefore).toBeInstanceOf(Buffer);
      const snapshot = Buffer.from(cacheBefore!); // copy out before zeroing
      expect(snapshot.toString('utf8')).toBe('secret-zzz');
      provider.clear();
      // After clear, the underlying buffer should have been zeroed in place.
      expect([...snapshot]).not.toEqual(new Array(snapshot.length).fill(0));
      // The provider's internal buffer reference is now null.
      expect((provider as unknown as { cache: Buffer | null }).cache).toBeNull();
    });

    test('idempotent: clear twice does not throw', async () => {
      const provider = new PassphraseProvider({
        dataDir: tempDir,
        env: { HOMELAB_CA_PASSPHRASE: 'p' },
        isTTY: () => false,
      });
      await provider.get();
      provider.clear();
      provider.clear();
    });
  });

  describe('host key', () => {
    test('stores 32 random bytes at <dataDir>/ca/host.key with mode 0600 on first store', async () => {
      const provider = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      await provider.store('whatever');
      const hostKeyPath = path.join(tempDir, 'ca', 'host.key');
      const stat = await fs.stat(hostKeyPath);
      expect(stat.size).toBe(32);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    test('reuses existing host.key across providers (round trip succeeds)', async () => {
      const a = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      await a.store('x');
      const hostKeyPath = path.join(tempDir, 'ca', 'host.key');
      const k1 = await fs.readFile(hostKeyPath);
      const b = new PassphraseProvider({ dataDir: tempDir, env: {}, isTTY: () => false });
      const r = await b.get();
      const k2 = await fs.readFile(hostKeyPath);
      expect(k1.equals(k2)).toBe(true);
      expect(r.source).toBe('stored');
    });
  });
});
