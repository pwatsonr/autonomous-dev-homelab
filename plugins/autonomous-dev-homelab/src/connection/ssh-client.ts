/**
 * Thin wrapper around the system `ssh` binary that authenticates with an
 * OpenSSH user certificate. Implements SPEC-001-2-02
 * §"`src/connection/ssh-client.ts`".
 *
 * Implementation note (deviation from spec): the spec suggests `node-ssh`
 * (which transitively pulls `ssh2`). PLAN-001-2 constraints lean toward
 * Node built-ins and explicit `execFile` invocations, so this wrapper
 * shells out to `ssh` from PATH. Functionally equivalent for cert auth:
 * `ssh -i <key> -o CertificateFile=<cert> ...`. Tests inject a fake
 * runner so no real network or `ssh` binary is required.
 */

import * as childProcess from 'node:child_process';
import { ConnectionTimeoutError, SSHAuthError } from './errors.js';
import type { ExecResult } from './base.js';

export interface SSHCertCredentials {
  host: string;
  port?: number;
  username: string;
  privateKeyPath: string;
  certPath: string;
  /** When unset, strict host-key checking is disabled with a logger warning. */
  knownHostsPath?: string;
  /** Override `ssh` binary; defaults to PATH lookup. */
  sshBin?: string;
}

export interface SSHRunOptions {
  timeoutMs?: number;
}

/**
 * Function shape used to spawn an external command with structured
 * stdio. Tests inject fakes that simulate ssh behaviour without
 * touching the network.
 */
export type SSHRunner = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; input?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;

export class SSHClient {
  private creds?: SSHCertCredentials;
  private connected = false;
  private readonly runner: SSHRunner;

  constructor(opts: { runner?: SSHRunner } = {}) {
    this.runner = opts.runner ?? defaultRunner;
  }

  /**
   * "Connect" semantics for the SSH wrapper: validates credentials by
   * running a no-op (`true`) over ssh. If that fails non-zero, we throw
   * SSHAuthError so callers know the cert+key did not authenticate.
   */
  async connect(creds: SSHCertCredentials, timeoutMs = 10_000): Promise<void> {
    this.creds = creds;
    try {
      const r = await this.runner(creds.sshBin ?? 'ssh', this.buildArgs('true'), { timeoutMs });
      if (r.timedOut) throw new ConnectionTimeoutError('ssh', timeoutMs);
      if (r.exitCode !== 0) {
        throw new SSHAuthError(
          `ssh preflight failed (exit ${r.exitCode}): ${truncate(r.stderr, 400)}`,
        );
      }
      this.connected = true;
    } catch (err) {
      if (err instanceof ConnectionTimeoutError || err instanceof SSHAuthError) throw err;
      throw new SSHAuthError(`ssh preflight error: ${(err as Error).message}`, err as Error);
    }
  }

  async execCommand(cmd: string, opts: SSHRunOptions = {}): Promise<ExecResult> {
    if (!this.connected || !this.creds) {
      throw new SSHAuthError('SSHClient.execCommand called before connect()');
    }
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();
    const r = await this.runner(this.creds.sshBin ?? 'ssh', this.buildArgs(cmd), { timeoutMs });
    const durationMs = Date.now() - start;
    if (r.timedOut) throw new ConnectionTimeoutError('ssh', timeoutMs);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs,
    };
  }

  async disconnect(): Promise<void> {
    // No persistent socket: ssh-per-exec. Mark disconnected; idempotent.
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private buildArgs(remoteCommand: string): string[] {
    if (!this.creds) throw new Error('buildArgs called without credentials');
    const c = this.creds;
    const args = ['-p', String(c.port ?? 22), '-i', c.privateKeyPath];
    // Only pass CertificateFile when a signed cert is configured. Plain key
    // auth (no SSH CA) leaves certPath empty; emitting `CertificateFile=` with
    // no value makes ssh abort ("no argument after keyword certificatefile").
    if (c.certPath !== undefined && c.certPath !== '') {
      args.push('-o', `CertificateFile=${c.certPath}`);
    }
    args.push(
      '-o',
      'BatchMode=yes',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'PubkeyAuthentication=yes',
      '-o',
      'IdentitiesOnly=yes',
    );
    if (c.knownHostsPath !== undefined) {
      args.push('-o', `UserKnownHostsFile=${c.knownHostsPath}`, '-o', 'StrictHostKeyChecking=yes');
    } else {
      args.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null');
    }
    args.push(`${c.username}@${c.host}`, '--', remoteCommand);
    return args;
  }
}

const defaultRunner: SSHRunner = (file, args, opts) =>
  new Promise((resolve) => {
    const child = childProcess.spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? (signal ? 128 : 1),
        timedOut,
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: 127,
        timedOut,
      });
    });
  });

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
