/**
 * Integration test: real SSH cert authentication end-to-end. Implements
 * SPEC-001-2-05 §"Integration Test".
 *
 * Spins up an OpenSSH container that trusts the homelab CA. Verifies:
 *   1. Valid cert authenticates and `whoami` returns `root`.
 *   2. Expired cert is rejected.
 *   3. Revoked cert is rejected after KRL update + sshd HUP.
 *   4. Wrong-CA cert is rejected.
 *   5. After key rotation, the new cert works; old cert works until KRL
 *      distributed; old cert fails after KRL distribution.
 *
 * Runtime budget: under 60s on a typical dev machine, excluding image
 * build (one-time cost cached by BuildKit).
 *
 * Gating:
 *   - This test requires Docker AND `ssh-keygen` AND the system `ssh`
 *     binary on PATH. It is skipped by default. Set `DOCKER_INTEGRATION=1`
 *     to opt in. CI runs it via `DOCKER_INTEGRATION=1 npm test`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

import { SSHCertificateManager } from '../../src/ca/manager';
import { SSHClient } from '../../src/connection/ssh-client';
import { SSHAuthError } from '../../src/connection/errors';
import {
  buildSshdImage,
  isDockerAvailable,
  startSshdContainer,
  type SshdContainer,
} from './helpers/sshd-container';

const execFileAsync = promisify(childProcess.execFile);

const DOCKER_GATE = process.env.DOCKER_INTEGRATION === '1';

// Run the suite only when the operator explicitly opts in. Without the
// gate, default `npm test` skips this entirely so contributors without
// Docker can still iterate on unit tests.
const maybeDescribe = DOCKER_GATE ? describe : describe.skip;

maybeDescribe('SSH cert auth (integration)', () => {
  let workDir: string;
  let ca: SSHCertificateManager;
  let container: SshdContainer | undefined;
  let dockerOk = false;
  let toolsOk = false;

  jest.setTimeout(180_000);

  beforeAll(async () => {
    dockerOk = await isDockerAvailable();
    if (!dockerOk) return;
    // Verify ssh-keygen + ssh exist; if missing, the suite cannot run.
    try {
      await execFileAsync('ssh-keygen', ['-V']).catch(async () => {
        await execFileAsync('ssh-keygen', ['-?']);
      });
      await execFileAsync('ssh', ['-V']);
      toolsOk = true;
    } catch {
      toolsOk = false;
      return;
    }
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-cert-int-'));
    ca = new SSHCertificateManager({ dataDir: workDir });
    await ca.initializeCA('test-passphrase');
    // Start with an empty KRL.
    const krlPath = path.join(workDir, 'homelab_ca.krl');
    await ca.generateKRL('test-passphrase', krlPath);
    await buildSshdImage();
    container = await startSshdContainer({ caPubPath: ca.caPubPath(), krlPath });
  });

  afterAll(async () => {
    if (container) await container.stop();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  function ensureReady(): { container: SshdContainer; ca: SSHCertificateManager } {
    if (!dockerOk || !toolsOk || !container) {
      throw new Error('integration test prerequisites not satisfied (docker/ssh-keygen/ssh)');
    }
    return { container, ca };
  }

  function makeClient(): SSHClient {
    return new SSHClient();
  }

  it('valid cert authenticates and exec returns expected output', async () => {
    const { container } = ensureReady();
    await ca.signPlatformCert('host-valid', 7, 'root', 'test-passphrase');
    const client = makeClient();
    await client.connect({
      host: container.host,
      port: container.port,
      username: 'root',
      privateKeyPath: ca.userKeyPath('host-valid'),
      certPath: ca.userCertPath('host-valid'),
    });
    const r = await client.execCommand('whoami');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('root');
    await client.disconnect();
  });

  it('expired cert is rejected by sshd', async () => {
    const { container } = ensureReady();
    // Generate the platform key first (validityDays=1) so we have a key
    // pair on disk. Then re-sign with a -V range that is already expired.
    await ca.signPlatformCert('host-expired', 1, 'root', 'test-passphrase');
    // Manually re-sign with a backdated validity using ssh-keygen directly
    // so the cert is unambiguously expired.
    const keysDir = path.dirname(ca.userPubPath('host-expired'));
    await execFileAsync('ssh-keygen', [
      '-s',
      ca.caKeyPath(),
      '-P',
      'test-passphrase',
      '-I',
      'host-expired',
      '-n',
      'root',
      '-V',
      '-2d:-1d',
      '-z',
      '999',
      ca.userPubPath('host-expired'),
    ]);
    // ssh-keygen wrote to <basename>-cert.pub; move into the canonical .cert path.
    const generated = path.join(keysDir, 'host-expired-cert.pub');
    await fs.rename(generated, ca.userCertPath('host-expired'));

    const client = makeClient();
    await expect(
      client.connect({
        host: container.host,
        port: container.port,
        username: 'root',
        privateKeyPath: ca.userKeyPath('host-expired'),
        certPath: ca.userCertPath('host-expired'),
      }),
    ).rejects.toBeInstanceOf(SSHAuthError);
  });

  it('revoked cert is rejected after KRL update + sshd HUP', async () => {
    const { container } = ensureReady();
    await ca.signPlatformCert('host-revoke', 7, 'root', 'test-passphrase');
    const client = makeClient();
    // Pre-revoke: connect succeeds.
    await client.connect({
      host: container.host,
      port: container.port,
      username: 'root',
      privateKeyPath: ca.userKeyPath('host-revoke'),
      certPath: ca.userCertPath('host-revoke'),
    });
    await client.disconnect();

    // Revoke and rebuild KRL.
    await ca.revokeKeys('host-revoke');
    const krlPath = path.join(workDir, 'homelab_ca.krl');
    await ca.generateKRL('test-passphrase', krlPath);
    await container.updateKRL(krlPath);
    await container.hup();
    // Allow sshd a moment to re-read RevokedKeys.
    await new Promise((r) => setTimeout(r, 250));

    const client2 = makeClient();
    await expect(
      client2.connect({
        host: container.host,
        port: container.port,
        username: 'root',
        privateKeyPath: ca.userKeyPath('host-revoke'),
        certPath: ca.userCertPath('host-revoke'),
      }),
    ).rejects.toBeInstanceOf(SSHAuthError);
  });

  it('wrong-CA cert is rejected', async () => {
    const { container } = ensureReady();
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-cert-other-'));
    try {
      const otherCa = new SSHCertificateManager({ dataDir: otherDir });
      await otherCa.initializeCA('other-pass');
      await otherCa.signPlatformCert('host-wrongca', 7, 'root', 'other-pass');
      const client = makeClient();
      await expect(
        client.connect({
          host: container.host,
          port: container.port,
          username: 'root',
          privateKeyPath: otherCa.userKeyPath('host-wrongca'),
          certPath: otherCa.userCertPath('host-wrongca'),
        }),
      ).rejects.toBeInstanceOf(SSHAuthError);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('rotation: new cert works; old cert fails after KRL distribution', async () => {
    const { container } = ensureReady();
    await ca.signPlatformCert('host-rotate', 7, 'root', 'test-passphrase');
    // Cache the old cert/key bytes so we can attempt to use them after rotation.
    const oldKeyBackup = path.join(workDir, 'rotate-old.key');
    const oldCertBackup = path.join(workDir, 'rotate-old.cert');
    await fs.copyFile(ca.userKeyPath('host-rotate'), oldKeyBackup);
    await fs.copyFile(ca.userCertPath('host-rotate'), oldCertBackup);
    await fs.chmod(oldKeyBackup, 0o600);

    // Sanity: old cert works pre-rotation.
    const pre = makeClient();
    await pre.connect({
      host: container.host,
      port: container.port,
      username: 'root',
      privateKeyPath: oldKeyBackup,
      certPath: oldCertBackup,
    });
    await pre.disconnect();

    // Rotate.
    await ca.rotateKey('host-rotate', 'test-passphrase');

    // New cert works immediately.
    const newClient = makeClient();
    await newClient.connect({
      host: container.host,
      port: container.port,
      username: 'root',
      privateKeyPath: ca.userKeyPath('host-rotate'),
      certPath: ca.userCertPath('host-rotate'),
    });
    const r = await newClient.execCommand('whoami');
    expect(r.stdout.trim()).toBe('root');
    await newClient.disconnect();

    // Old cert still works until KRL is distributed.
    const stillWorks = makeClient();
    await stillWorks.connect({
      host: container.host,
      port: container.port,
      username: 'root',
      privateKeyPath: oldKeyBackup,
      certPath: oldCertBackup,
    });
    await stillWorks.disconnect();

    // Distribute KRL (rotation appended old fingerprint to revocation.list).
    const krlPath = path.join(workDir, 'homelab_ca.krl');
    await ca.generateKRL('test-passphrase', krlPath);
    await container.updateKRL(krlPath);
    await container.hup();
    await new Promise((r) => setTimeout(r, 250));

    const blocked = makeClient();
    await expect(
      blocked.connect({
        host: container.host,
        port: container.port,
        username: 'root',
        privateKeyPath: oldKeyBackup,
        certPath: oldCertBackup,
      }),
    ).rejects.toBeInstanceOf(SSHAuthError);
  });
});

// Always-present marker test so that even with the suite skipped Jest
// reports a pending test instead of "no tests in file".
describe('SSH cert auth (integration) gate', () => {
  it('skips when DOCKER_INTEGRATION env var is unset', () => {
    if (!DOCKER_GATE) {
      // eslint-disable-next-line no-console
      console.warn(
        'SKIP: integration test gated; set DOCKER_INTEGRATION=1 (and have Docker + ssh-keygen + ssh) to run.',
      );
    }
    expect(true).toBe(true);
  });
});
