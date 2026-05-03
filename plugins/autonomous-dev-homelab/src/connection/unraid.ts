/**
 * `UnraidConnection`: SSH-only (no MCP, no REST). Implements
 * SPEC-001-2-03 §"`src/connection/unraid.ts`".
 *
 * Operators must enable SSH on Unraid (default in recent versions).
 */

import { Connection } from './base.js';
import type { ExecOptions, ExecResult } from './base.js';
import { SSHAuthError } from './errors.js';
import { SSHClient, type SSHCertCredentials } from './ssh-client.js';

export interface UnraidConnectionOptions {
  hostname: string;
  sshUser?: string;
  sshPort?: number;
  privateKeyPath: string;
  certPath: string;
  sshClient?: SSHClient;
}

export class UnraidConnection extends Connection {
  protected readonly opts: UnraidConnectionOptions;
  protected readonly sshClient: SSHClient;

  constructor(platformId: string, opts: UnraidConnectionOptions) {
    super(platformId);
    this.opts = opts;
    this.sshClient = opts.sshClient ?? new SSHClient();
  }

  override async connect(): Promise<void> {
    this.lastUsedAt = Date.now();
    const creds: SSHCertCredentials = {
      host: this.opts.hostname,
      ...(this.opts.sshPort !== undefined ? { port: this.opts.sshPort } : {}),
      username: this.opts.sshUser ?? 'root',
      privateKeyPath: this.opts.privateKeyPath,
      certPath: this.opts.certPath,
    };
    await this.sshClient.connect(creds);
    this.connected = true;
    this.capabilities = {
      transport: 'ssh',
      hostname: this.opts.hostname,
      user: creds.username,
    };
  }

  override async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.connected) {
      throw new SSHAuthError('exec called before connect()');
    }
    this.lastUsedAt = Date.now();
    return this.sshClient.execCommand(
      command,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
    );
  }

  override async disconnect(): Promise<void> {
    try {
      await this.sshClient.disconnect();
    } catch {
      // best-effort
    }
    this.connected = false;
  }
}
