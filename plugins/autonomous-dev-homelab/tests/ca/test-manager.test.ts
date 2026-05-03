/**
 * SSHCertificateManager tests. Covers SPEC-001-2-01 acceptance criteria
 * for `src/ca/manager.ts`.
 *
 * Uses an injected fake `execFile` so the test is hermetic: the suite
 * does not require `ssh-keygen` to be installed on the host. The fake
 * mimics ssh-keygen's filesystem side-effects: key generation creates
 * `<keypath>` and `<keypath>.pub`; cert signing creates the
 * `<pubpath without ".pub">-cert.pub` file.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SSHCertificateManager } from '../../src/ca/manager';
import { CAAlreadyExistsError, CAError } from '../../src/ca/types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface FakeArgs {
  file: string;
  args: string[];
}

function makeFakeExecFile(opts: {
  passphrase?: string;
  fingerprintByPath?: (p: string) => string;
  validForDays?: number;
} = {}) {
  const calls: FakeArgs[] = [];
  // Keep fingerprints base64-safe so the manager's `/SHA256:[A-Za-z0-9+/=]+/`
  // regex captures the full string (no dashes / dots / underscores).
  const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '');
  const fingerprintByPath =
    opts.fingerprintByPath ??
    ((p: string): string => `SHA256:fpof${sanitize(path.basename(p))}`);
  const validForDays = opts.validForDays ?? 7;

  const fake = async (
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args: [...args] });
    if (file !== 'ssh-keygen') {
      throw new Error(`unexpected exec: ${file}`);
    }
    // Keygen invocation: ssh-keygen -t ed25519 -f <path> -N <pass> -C <comment>
    if (args.includes('-t') && args.includes('-f') && args.includes('-N')) {
      const fIdx = args.indexOf('-f');
      const keyPath = args[fIdx + 1] ?? '';
      const nIdx = args.indexOf('-N');
      const providedPass = args[nIdx + 1] ?? '';
      if (opts.passphrase !== undefined && providedPass !== '' && providedPass !== opts.passphrase) {
        throw new Error('ssh-keygen failed: bad passphrase');
      }
      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, `FAKE-PRIV ${path.basename(keyPath)}`);
      await fs.writeFile(`${keyPath}.pub`, `ssh-ed25519 FAKEPUB ${path.basename(keyPath)}`);
      return { stdout: '', stderr: '' };
    }
    // Sign invocation: ssh-keygen -s <ca-key> -P <pass> -I <id> -n <princ> -V +Nd -z <serial> <pubpath>
    if (args[0] === '-s') {
      const sIdx = args.indexOf('-s');
      const caKey = args[sIdx + 1] ?? '';
      const pIdx = args.indexOf('-P');
      const providedPass = args[pIdx + 1] ?? '';
      if (opts.passphrase !== undefined && providedPass !== opts.passphrase) {
        throw new Error('ssh-keygen failed: bad CA passphrase');
      }
      // Last arg is the user pubkey path.
      const pubPath = args[args.length - 1] ?? '';
      const certPath = `${pubPath.slice(0, -'.pub'.length)}-cert.pub`;
      await fs.writeFile(
        certPath,
        `ssh-ed25519-cert-v01@openssh.com FAKECERT signed-by=${path.basename(caKey)}`,
      );
      return { stdout: '', stderr: '' };
    }
    // Fingerprint short-form: ssh-keygen -l -f <path>
    if (args[0] === '-l' && args[1] === '-f') {
      const target = args[2] ?? '';
      return {
        stdout: `256 ${fingerprintByPath(target)} comment (ED25519)\n`,
        stderr: '',
      };
    }
    // Detail form: ssh-keygen -L -f <cert>
    if (args[0] === '-L' && args[1] === '-f') {
      const target = args[2] ?? '';
      const platformId = path.basename(target).replace(/\.cert$/, '');
      const validBefore = new Date(Date.now() + validForDays * 86400_000).toISOString();
      return {
        stdout:
          `${target}:\n` +
          `  Type: ssh-ed25519-cert-v01@openssh.com user certificate\n` +
          `  Public key: ED25519-CERT ${fingerprintByPath(target)}\n` +
          `  Signing CA: ED25519 SHA256:fakeCA (using ssh-ed25519)\n` +
          `  Key ID: "${platformId}"\n` +
          `  Serial: 1\n` +
          `  Valid: from 2026-01-01T00:00:00 to ${validBefore}\n` +
          `  Principals:\n` +
          `        root\n` +
          `  Critical Options: (none)\n` +
          `  Extensions: permit-pty\n`,
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
  return { fake, calls };
}

describe('SSHCertificateManager', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkTempDir();
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  describe('initializeCA', () => {
    test('creates ca/homelab_ca.{key,pub} with correct modes', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'correct horse' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('correct horse');
      const keyStat = await fs.stat(mgr.caKeyPath());
      const pubStat = await fs.stat(mgr.caPubPath());
      expect(keyStat.mode & 0o777).toBe(0o600);
      expect(pubStat.mode & 0o777).toBe(0o644);
      // Revocation list is created with mode 0600.
      const revStat = await fs.stat(mgr.revocationListPath());
      expect(revStat.mode & 0o777).toBe(0o600);
    });

    test('rejects empty passphrase', async () => {
      const { fake } = makeFakeExecFile();
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await expect(mgr.initializeCA('')).rejects.toMatchObject({ code: 'EMPTY_PASSPHRASE' });
    });

    test('throws CAAlreadyExistsError on second init; existing CA untouched', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'p1' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('p1');
      const before = await fs.readFile(mgr.caKeyPath());
      await expect(mgr.initializeCA('p1')).rejects.toBeInstanceOf(CAAlreadyExistsError);
      const after = await fs.readFile(mgr.caKeyPath());
      expect(before.equals(after)).toBe(true);
    });
  });

  describe('signPlatformCert', () => {
    test('produces keys/<id>.{key,pub,cert}; cert validity reported via -L', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp', validForDays: 7 });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      const certPath = await mgr.signPlatformCert('proxmox-01', 7, 'root', 'pp');
      expect(certPath).toBe(path.join(tempDir, 'keys', 'proxmox-01.cert'));
      await fs.access(mgr.userKeyPath('proxmox-01'));
      await fs.access(mgr.userPubPath('proxmox-01'));
      await fs.access(mgr.userCertPath('proxmox-01'));
      const list = await mgr.listCertificates();
      const meta = list.find((m) => m.platformId === 'proxmox-01');
      expect(meta).toBeDefined();
      // Validity date was extracted from the fake -L output.
      expect(meta!.validBefore).not.toBe('');
    });

    test('reuses existing user key on second signing', async () => {
      const { fake, calls } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      const keygenCallsAfterFirst = calls.filter(
        (c) => c.args[0] === '-t' && c.args.includes('p1'),
      ).length;
      // Capture the private key contents to verify it does not change.
      const keyPath = mgr.userKeyPath('p1');
      const beforeKey = await fs.readFile(keyPath);
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      const afterKey = await fs.readFile(keyPath);
      expect(beforeKey.equals(afterKey)).toBe(true);
      const keygenCallsAfterSecond = calls.filter(
        (c) => c.args[0] === '-t' && c.args.includes('p1'),
      ).length;
      // No additional `-t` invocation for the same platform id.
      expect(keygenCallsAfterSecond).toBe(keygenCallsAfterFirst);
    });

    test('generates fresh key for new platform-id', async () => {
      const { fake, calls } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      await mgr.signPlatformCert('p2', 7, 'root', 'pp');
      const p1Keys = calls.filter((c) => c.args[0] === '-t' && c.args.includes('p1')).length;
      const p2Keys = calls.filter((c) => c.args[0] === '-t' && c.args.includes('p2')).length;
      expect(p1Keys).toBe(1);
      expect(p2Keys).toBe(1);
    });

    test('assigns monotonically increasing serials and persists counter atomically', async () => {
      const { fake, calls } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      await mgr.signPlatformCert('p2', 7, 'root', 'pp');
      const signCalls = calls.filter((c) => c.args[0] === '-s');
      const serials = signCalls.map((c) => {
        const idx = c.args.indexOf('-z');
        return parseInt(c.args[idx + 1] ?? '0', 10);
      });
      expect(serials).toHaveLength(2);
      expect(serials[1]!).toBeGreaterThan(serials[0]!);
      // Counter file exists and is mode 0600.
      const counterStat = await fs.stat(mgr.serialCounterPath());
      expect(counterStat.mode & 0o777).toBe(0o600);
    });

    test('throws if CA not initialized', async () => {
      const { fake } = makeFakeExecFile();
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await expect(mgr.signPlatformCert('p1', 7, 'root', 'pp')).rejects.toMatchObject({
        code: 'NO_CA',
      });
    });

    test('rejects non-positive validity days', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await expect(mgr.signPlatformCert('p1', 0, 'root', 'pp')).rejects.toBeInstanceOf(CAError);
    });
  });

  describe('revokeKeys', () => {
    test('appends one tab-separated entry to revocation.list', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      const fixedNow = new Date('2026-05-02T03:04:05.000Z');
      const entry = await mgr.revokeKeys('p1', fixedNow);
      expect(entry.platformId).toBe('p1');
      expect(entry.revokedAt).toBe('2026-05-02T03:04:05.000Z');
      const raw = await fs.readFile(mgr.revocationListPath(), 'utf8');
      const lines = raw.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(1);
      const parts = lines[0]!.split('\t');
      expect(parts[0]).toBe('p1');
      expect(parts[1]).toMatch(/^SHA256:/);
      expect(parts[2]).toBe('2026-05-02T03:04:05.000Z');
    });

    test('throws when no cert exists for platform', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await expect(mgr.revokeKeys('does-not-exist')).rejects.toMatchObject({ code: 'NO_CERT' });
    });
  });

  describe('getCAPublicKey', () => {
    test('returns the exact contents of homelab_ca.pub', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      const expected = await fs.readFile(mgr.caPubPath(), 'utf8');
      const actual = await mgr.getCAPublicKey();
      expect(actual).toBe(expected);
    });
  });

  describe('listCertificates', () => {
    test('reports revoked flag for entries in revocation.list', async () => {
      const { fake } = makeFakeExecFile({ passphrase: 'pp' });
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: fake });
      await mgr.initializeCA('pp');
      await mgr.signPlatformCert('p1', 7, 'root', 'pp');
      await mgr.signPlatformCert('p2', 7, 'root', 'pp');
      await mgr.revokeKeys('p1');
      const list = await mgr.listCertificates();
      const p1 = list.find((m) => m.platformId === 'p1');
      const p2 = list.find((m) => m.platformId === 'p2');
      expect(p1!.revoked).toBe(true);
      expect(p2!.revoked).toBe(false);
    });

    test('returns [] when keys dir does not exist', async () => {
      const mgr = new SSHCertificateManager({ dataDir: tempDir, execFile: makeFakeExecFile().fake });
      const list = await mgr.listCertificates();
      expect(list).toEqual([]);
    });
  });
});
