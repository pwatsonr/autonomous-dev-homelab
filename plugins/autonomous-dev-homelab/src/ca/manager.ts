/**
 * `SSHCertificateManager`: operator-managed SSH certificate authority
 * for the homelab plugin. Implements SPEC-001-2-01 §"`src/ca/manager.ts`"
 * / TDD-001 §9.
 *
 * Storage layout under `<dataDir>/`:
 *
 *   ca/
 *     homelab_ca.key       mode 0600  Ed25519 private key (encrypted via -N)
 *     homelab_ca.pub       mode 0644  CA public key (operator distributes)
 *     revocation.list      mode 0600  one entry per line: <id>\t<fp>\t<iso>
 *     serial.counter       mode 0600  monotonically increasing serial
 *   keys/
 *     <platform-id>.key    mode 0600  user private key
 *     <platform-id>.pub    mode 0644
 *     <platform-id>.cert   mode 0644  ssh-keygen-signed certificate
 *
 * Every external command is invoked via `execFile` with explicit args
 * (no shell interpolation). On non-zero exit, the manager throws
 * `CAError` with the captured stderr.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile } from '../util/atomic-write.js';
import {
  CAAlreadyExistsError,
  CAError,
  type CertificateMetadata,
  type RevocationEntry,
  type RotationResult,
} from './types.js';

const execFileAsync = promisify(childProcess.execFile);

/**
 * Simplified async execFile signature suitable for test injection. Tests
 * provide a fake that returns `{stdout, stderr}` strings; production
 * delegates to Node's promisified `execFile`.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface SSHCertificateManagerOptions {
  dataDir: string;
  /** Override `ssh-keygen` binary. Defaults to PATH lookup. */
  sshKeygenBin?: string;
  /** Injectable execFile for tests. */
  execFile?: ExecFileFn;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

export class SSHCertificateManager {
  private readonly dataDir: string;
  private readonly sshKeygenBin: string;
  private readonly execFile: ExecFileFn;

  constructor(opts: SSHCertificateManagerOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.sshKeygenBin = opts.sshKeygenBin ?? 'ssh-keygen';
    if (opts.execFile) {
      this.execFile = opts.execFile;
    } else {
      this.execFile = async (file, args): Promise<ExecResult> => {
        try {
          const r = await execFileAsync(file, [...args]);
          return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: number | string };
          throw new CAError(
            'SSH_KEYGEN_FAILED',
            `${file} failed: ${e.stderr ?? e.message ?? 'unknown error'}`,
          );
        }
      };
    }
  }

  // --- CA lifecycle ------------------------------------------------------

  /** Initialize the CA. Throws CAAlreadyExistsError if the CA key exists. */
  async initializeCA(passphrase: string): Promise<void> {
    if (passphrase === '') {
      throw new CAError('EMPTY_PASSPHRASE', 'CA passphrase must not be empty');
    }
    if (await fileExists(this.caKeyPath())) {
      throw new CAAlreadyExistsError(`CA already exists at ${this.caKeyPath()}`);
    }
    await fs.mkdir(this.caDir(), { recursive: true });
    await fs.mkdir(this.keysDir(), { recursive: true });
    // ssh-keygen given `-f <basename>` writes `<basename>` + `<basename>.pub`.
    // Use an extensionless basename so the public key naturally lands at
    // `homelab_ca.pub`, then rename the private key to `homelab_ca.key`.
    const caBasename = path.join(this.caDir(), 'homelab_ca');
    await this.execFile(this.sshKeygenBin, [
      '-t',
      'ed25519',
      '-f',
      caBasename,
      '-N',
      passphrase,
      '-C',
      'homelab-ca',
    ]);
    if (await fileExists(caBasename)) {
      await fs.rename(caBasename, this.caKeyPath());
    }
    // Set explicit modes; do not rely on umask.
    await fs.chmod(this.caKeyPath(), 0o600);
    await fs.chmod(this.caPubPath(), 0o644);
    // Ensure revocation.list exists with mode 0600.
    await atomicWriteFile(this.revocationListPath(), '', { mode: 0o600 });
    await fs.chmod(this.revocationListPath(), 0o600);
    // Initialize serial counter at 1 so first signed cert gets serial 1.
    await this.writeSerialCounter(1);
  }

  /** Returns the contents of `homelab_ca.pub`. */
  async getCAPublicKey(): Promise<string> {
    return fs.readFile(this.caPubPath(), 'utf8');
  }

  // --- signing -----------------------------------------------------------

  /**
   * Sign a per-platform certificate. Generates the platform's user key
   * if it does not yet exist; reuses it if it does. Returns the absolute
   * path to the produced cert.
   */
  async signPlatformCert(
    platformId: string,
    validityDays: number,
    principal: string,
    passphrase: string,
  ): Promise<string> {
    if (validityDays <= 0) {
      throw new CAError('BAD_VALIDITY', `validityDays must be > 0; got ${validityDays}`);
    }
    if (!await fileExists(this.caKeyPath())) {
      throw new CAError('NO_CA', 'CA has not been initialized');
    }
    await fs.mkdir(this.keysDir(), { recursive: true });
    const keyPath = this.userKeyPath(platformId);
    if (!await fileExists(keyPath)) {
      // Same `-f <basename>` rename trick as initializeCA so the public
      // key lands at `<id>.pub` naturally.
      const userBasename = path.join(this.keysDir(), platformId);
      await this.execFile(this.sshKeygenBin, [
        '-t',
        'ed25519',
        '-f',
        userBasename,
        '-N',
        '',
        '-C',
        platformId,
      ]);
      if (await fileExists(userBasename)) {
        await fs.rename(userBasename, keyPath);
      }
      await fs.chmod(keyPath, 0o600);
      await fs.chmod(this.userPubPath(platformId), 0o644);
    }
    const serial = await this.nextSerial();
    await this.execFile(this.sshKeygenBin, [
      '-s',
      this.caKeyPath(),
      '-P',
      passphrase,
      '-I',
      platformId,
      '-n',
      principal,
      '-V',
      `+${validityDays}d`,
      '-z',
      String(serial),
      this.userPubPath(platformId),
    ]);
    // ssh-keygen -s writes the cert to `<pubkey-without-.pub>-cert.pub`,
    // i.e. `keys/<id>-cert.pub`. We rename to the canonical `<id>.cert`
    // path documented in SPEC-001-2-01.
    const sshKeygenCertPath = path.join(this.keysDir(), `${platformId}-cert.pub`);
    if (await fileExists(sshKeygenCertPath)) {
      await fs.rename(sshKeygenCertPath, this.userCertPath(platformId));
    }
    await fs.chmod(this.userCertPath(platformId), 0o644);
    return this.userCertPath(platformId);
  }

  /**
   * Append a revocation record for `platformId`. Reads the cert's
   * fingerprint via `ssh-keygen -L`. Does not delete files — operators
   * may need them for forensic review.
   */
  async revokeKeys(platformId: string, now: Date = new Date()): Promise<RevocationEntry> {
    const certPath = this.userCertPath(platformId);
    if (!await fileExists(certPath)) {
      throw new CAError('NO_CERT', `no cert for ${platformId} at ${certPath}`);
    }
    const fp = await this.fingerprint(certPath);
    const entry: RevocationEntry = {
      platformId,
      fingerprint: fp,
      revokedAt: now.toISOString(),
    };
    await fs.mkdir(path.dirname(this.revocationListPath()), { recursive: true });
    await fs.appendFile(
      this.revocationListPath(),
      `${entry.platformId}\t${entry.fingerprint}\t${entry.revokedAt}\n`,
      { mode: 0o600 },
    );
    await fs.chmod(this.revocationListPath(), 0o600);
    return entry;
  }

  /** Enumerate `keys/*.cert` and report metadata. Best-effort metadata extraction. */
  async listCertificates(): Promise<CertificateMetadata[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.keysDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const revoked = await this.readRevocationFingerprints();
    const out: CertificateMetadata[] = [];
    for (const name of entries) {
      if (!name.endsWith('.cert')) continue;
      const platformId = name.slice(0, -'.cert'.length);
      const certPath = path.join(this.keysDir(), name);
      let fp = '';
      let principal = '';
      let validBefore = '';
      try {
        const meta = await this.readCertMetadata(certPath);
        fp = meta.fingerprint;
        principal = meta.principal;
        validBefore = meta.validBefore;
      } catch {
        // Best effort; skip details if ssh-keygen -L fails.
      }
      out.push({
        platformId,
        principal,
        validBefore,
        fingerprint: fp,
        revoked: revoked.has(fp),
      });
    }
    return out;
  }

  /**
   * Stub for SPEC-001-2-04. Throws so subclasses may import the manager
   * without depending on a future spec.
   */
  async rotateKey(_platformId: string, _passphrase: string): Promise<RotationResult> {
    throw new CAError(
      'NOT_IMPLEMENTED',
      'rotateKey is not implemented; see SPEC-001-2-04',
    );
  }

  // --- helpers (also used by SPEC-001-2-04) -------------------------------

  /** Return the SHA256 fingerprint of an ssh public key or cert via `-L`. */
  async fingerprint(certOrKeyPath: string): Promise<string> {
    const r = await this.execFile(this.sshKeygenBin, ['-l', '-f', certOrKeyPath]);
    // Output format: "<bits> SHA256:abc... <comment> (CERT|ED25519|...)"
    const match = r.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
    if (!match) {
      throw new CAError('FINGERPRINT_PARSE_FAILED', `could not parse fingerprint from: ${r.stdout}`);
    }
    return match[0];
  }

  /** Read the next serial number, incrementing the on-disk counter atomically. */
  private async nextSerial(): Promise<number> {
    const counterPath = this.serialCounterPath();
    let current = 1;
    try {
      const raw = await fs.readFile(counterPath, 'utf8');
      const parsed = parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) current = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const next = current + 1;
    await this.writeSerialCounter(next);
    return current;
  }

  private async writeSerialCounter(value: number): Promise<void> {
    await atomicWriteFile(this.serialCounterPath(), String(value), { mode: 0o600 });
    await fs.chmod(this.serialCounterPath(), 0o600);
  }

  private async readRevocationFingerprints(): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const raw = await fs.readFile(this.revocationListPath(), 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const parts = trimmed.split('\t');
        if (parts.length >= 2 && parts[1]) out.add(parts[1]);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return out;
  }

  private async readCertMetadata(
    certPath: string,
  ): Promise<{ fingerprint: string; principal: string; validBefore: string }> {
    const r = await this.execFile(this.sshKeygenBin, ['-L', '-f', certPath]);
    const fpMatch = r.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
    const principalMatch = r.stdout.match(/Principals:\s*\n\s+(\S+)/);
    const validMatch = r.stdout.match(/Valid:\s+from\s+\S+\s+to\s+(\S+\s+\S+)/);
    return {
      fingerprint: fpMatch ? fpMatch[0] : '',
      principal: principalMatch ? (principalMatch[1] ?? '') : '',
      validBefore: validMatch ? (validMatch[1] ?? '') : '',
    };
  }

  // --- path helpers -------------------------------------------------------

  caDir(): string {
    return path.join(this.dataDir, 'ca');
  }
  keysDir(): string {
    return path.join(this.dataDir, 'keys');
  }
  caKeyPath(): string {
    return path.join(this.caDir(), 'homelab_ca.key');
  }
  caPubPath(): string {
    return path.join(this.caDir(), 'homelab_ca.pub');
  }
  revocationListPath(): string {
    return path.join(this.caDir(), 'revocation.list');
  }
  serialCounterPath(): string {
    return path.join(this.caDir(), 'serial.counter');
  }
  userKeyPath(platformId: string): string {
    return path.join(this.keysDir(), `${platformId}.key`);
  }
  userPubPath(platformId: string): string {
    return path.join(this.keysDir(), `${platformId}.pub`);
  }
  userCertPath(platformId: string): string {
    return path.join(this.keysDir(), `${platformId}.cert`);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
