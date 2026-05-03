/**
 * `ca` CLI subcommand tests. Covers SPEC-001-3-03 acceptance criteria
 * for `ca init`, `ca rotate`, `ca list`, plus audit emission via the
 * SSHCertificateManager.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { buildCACommand } from '../../src/cli/commands/ca';
import { SSHCertificateManager } from '../../src/ca/manager';
import { InventoryManager } from '../../src/discovery/inventory';
import { AuditKeyStore } from '../../src/audit/key-store';
import { AuditWriter } from '../../src/audit/writer';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams(): {
  captured: CapturedStreams;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const captured: CapturedStreams = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s) => {
        captured.stdout += s;
      },
      stderr: (s) => {
        captured.stderr += s;
      },
    },
  };
}

/**
 * Fake ssh-keygen that mimics filesystem side effects without invoking
 * the real binary. Mirrors the helper used in tests/ca/test-manager.test.ts.
 */
function makeFakeExecFile(): (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }> {
  return async (file, args): Promise<{ stdout: string; stderr: string }> => {
    if (file !== 'ssh-keygen') throw new Error(`unexpected exec: ${file}`);
    // -t ed25519 -f <path> -N <pass> -C <comment>
    if (args.includes('-t') && args.includes('-f') && args.includes('-N')) {
      const fIdx = args.indexOf('-f');
      const keyPath = args[fIdx + 1] ?? '';
      await fs.mkdir(path.dirname(keyPath), { recursive: true });
      await fs.writeFile(keyPath, `FAKE-PRIV ${path.basename(keyPath)}`);
      await fs.writeFile(
        `${keyPath}.pub`,
        `ssh-ed25519 FAKEPUB ${path.basename(keyPath)}`,
      );
      return { stdout: '', stderr: '' };
    }
    // -s <ca-key> -P <pass> -I <id> -n <princ> -V +Nd -z <serial> <pubpath>
    if (args[0] === '-s') {
      const pubPath = args[args.length - 1] ?? '';
      const certPath = `${pubPath.slice(0, -'.pub'.length)}-cert.pub`;
      await fs.writeFile(certPath, 'FAKE CERT');
      return { stdout: '', stderr: '' };
    }
    // -l -f <path>
    if (args[0] === '-l' && args[1] === '-f') {
      const target = args[2] ?? '';
      const sanitized = path
        .basename(target)
        .replace(/[^A-Za-z0-9]/g, '');
      return {
        stdout: `256 SHA256:fpof${sanitized} comment (ED25519)\n`,
        stderr: '',
      };
    }
    // -L -f <cert>
    if (args[0] === '-L' && args[1] === '-f') {
      const target = args[2] ?? '';
      const platformId = path.basename(target).replace(/\.cert$/, '');
      // The fingerprint here MUST match what `-l -f` returns for the
      // same cert, otherwise the revocation list (keyed by `-l -f`
      // output) won't intersect listCertificates() (keyed by `-L -f`).
      const sanitized = path.basename(target).replace(/[^A-Za-z0-9]/g, '');
      return {
        stdout:
          `${target}:\n` +
          `  Public key: ED25519-CERT SHA256:fpof${sanitized}\n` +
          `  Key ID: "${platformId}"\n` +
          `  Valid: from 2026-01-01T00:00:00 to 2027-01-01T00:00:00\n` +
          `  Principals:\n` +
          `        root\n`,
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('ca CLI', () => {
  let tempDir: string;
  let inventoryPath: string;
  let auditPath: string;
  let auditKeyPath: string;
  let inventoryManager: InventoryManager;
  let auditWriter: AuditWriter;

  beforeEach(async () => {
    tempDir = await mkTempDir('ca-cli-');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
    auditPath = path.join(tempDir, 'audit.log');
    auditKeyPath = path.join(tempDir, '.audit-key');
    inventoryManager = new InventoryManager(inventoryPath);
    auditWriter = new AuditWriter({
      logPath: auditPath,
      keyStore: new AuditKeyStore({ keyPath: auditKeyPath }),
      defaultActor: 'pwatson',
    });
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  function makeCAManager(): SSHCertificateManager {
    return new SSHCertificateManager({
      dataDir: tempDir,
      execFile: makeFakeExecFile(),
      auditWriter,
    });
  }

  // ---- init -------------------------------------------------------------

  it('init initializes the CA from --passphrase-file (mode 0600)', async () => {
    const ppPath = path.join(tempDir, 'pp');
    await fs.writeFile(ppPath, 'secret\n', { mode: 0o600 });
    await fs.chmod(ppPath, 0o600);
    const caManager = makeCAManager();

    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(
      ['init', '--passphrase-file', ppPath, '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { ok: boolean; ca_dir: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.ca_dir).toBe(caManager.caDir());
    // Audit emission verified: ca_initialized.
    const log = await fs.readFile(auditPath, 'utf8');
    const entry = JSON.parse(log.trim()) as { event: string };
    expect(entry.event).toBe('ca_initialized');
  });

  it('init refuses when passphrase file mode is not 0600', async () => {
    const ppPath = path.join(tempDir, 'pp');
    await fs.writeFile(ppPath, 'secret\n', { mode: 0o644 });
    await fs.chmod(ppPath, 0o644);
    const caManager = makeCAManager();

    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(
      ['init', '--passphrase-file', ppPath],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('expected 0600');
  });

  it('init refuses when CA already exists', async () => {
    const ppPath = path.join(tempDir, 'pp');
    await fs.writeFile(ppPath, 'secret\n', { mode: 0o600 });
    await fs.chmod(ppPath, 0o600);
    const caManager = makeCAManager();
    await caManager.initializeCA('secret');

    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(
      ['init', '--passphrase-file', ppPath, '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('CA_ALREADY_EXISTS');
  });

  it('init with no --passphrase-file and no TTY exits 1', async () => {
    const caManager = makeCAManager();
    const { captured, streams } = captureStreams();
    const handle = buildCACommand({
      caManager,
      inventoryManager,
      streams,
      isTTY: () => false,
    });
    await handle.command.parseAsync(['init'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('passphrase required');
  });

  // ---- rotate -----------------------------------------------------------

  it('rotate exits 1 if platform unknown', async () => {
    const caManager = makeCAManager();
    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(
      ['rotate', 'ghost-host', '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('not in inventory');
  });

  it('rotate emits cert_revoked + cert_signed entries on success', async () => {
    // Bootstrap: CA + cert + inventory entry.
    const caManager = makeCAManager();
    await caManager.initializeCA('secret');
    await caManager.signPlatformCert('proxmox-01', 365, 'root', 'secret');
    await inventoryManager.addPlatform({
      id: 'proxmox-01',
      type: 'proxmox-ve',
      host: '192.168.1.10',
      port: 8006,
      discovered_at: '2026-04-28T10:00:00.000Z',
      last_seen: '2026-04-28T10:00:00.000Z',
    });
    // Drop log so we only see rotate's entries.
    await fs.unlink(auditPath);

    const oldEnv = process.env['HOMELAB_CA_PASSPHRASE'];
    process.env['HOMELAB_CA_PASSPHRASE'] = 'secret';
    try {
      const { captured, streams } = captureStreams();
      const handle = buildCACommand({ caManager, inventoryManager, streams });
      await handle.command.parseAsync(
        ['rotate', 'proxmox-01', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; platform_id: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.platform_id).toBe('proxmox-01');
      const log = await fs.readFile(auditPath, 'utf8');
      const entries = log
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { event: string });
      const events = entries.map((e) => e.event);
      expect(events).toContain('cert_revoked');
      expect(events).toContain('cert_signed');
    } finally {
      if (oldEnv === undefined) delete process.env['HOMELAB_CA_PASSPHRASE'];
      else process.env['HOMELAB_CA_PASSPHRASE'] = oldEnv;
    }
  });

  it('rotate exits 1 without HOMELAB_CA_PASSPHRASE set', async () => {
    const caManager = makeCAManager();
    await inventoryManager.addPlatform({
      id: 'proxmox-01',
      type: 'proxmox-ve',
      host: '192.168.1.10',
      port: 8006,
      discovered_at: '2026-04-28T10:00:00.000Z',
      last_seen: '2026-04-28T10:00:00.000Z',
    });
    const oldEnv = process.env['HOMELAB_CA_PASSPHRASE'];
    delete process.env['HOMELAB_CA_PASSPHRASE'];
    try {
      const { captured, streams } = captureStreams();
      const handle = buildCACommand({ caManager, inventoryManager, streams });
      await handle.command.parseAsync(['rotate', 'proxmox-01'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(1);
      expect(captured.stderr).toContain('HOMELAB_CA_PASSPHRASE');
    } finally {
      if (oldEnv !== undefined) process.env['HOMELAB_CA_PASSPHRASE'] = oldEnv;
    }
  });

  // ---- list -------------------------------------------------------------

  it('list prints "No certs signed." when empty', async () => {
    const caManager = makeCAManager();
    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('No certs signed.');
  });

  it('list prints active and revoked certs', async () => {
    const caManager = makeCAManager();
    await caManager.initializeCA('secret');
    await caManager.signPlatformCert('proxmox-01', 365, 'root', 'secret');
    await caManager.signPlatformCert('unraid-01', 365, 'root', 'secret');
    await caManager.revokeKeys('unraid-01');

    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('proxmox-01');
    expect(captured.stdout).toContain('unraid-01');
    expect(captured.stdout).toContain('active');
    expect(captured.stdout).toContain('revoked');
  });

  it('list --json emits the records as an array', async () => {
    const caManager = makeCAManager();
    await caManager.initializeCA('secret');
    await caManager.signPlatformCert('proxmox-01', 365, 'root', 'secret');

    const { captured, streams } = captureStreams();
    const handle = buildCACommand({ caManager, inventoryManager, streams });
    await handle.command.parseAsync(['list', '--json'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(captured.stdout) as Array<{ platformId: string; revoked: boolean }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.platformId).toBe('proxmox-01');
    expect(parsed[0]?.revoked).toBe(false);
  });
});
