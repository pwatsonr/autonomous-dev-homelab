/**
 * `TrueNasConnection`: REST-first via HTTPS, SSH cert fallback. Implements
 * SPEC-001-2-03 §"`src/connection/truenas.ts`".
 *
 * On REST preflight failure (timeout, 401/403, network), falls back to
 * SSH using the same cert-auth path as the Linux subclasses. When REST
 * is the active transport, `exec()` accepts the JSON-encoded HTTPS
 * descriptor convention shared with `UnifiConnection`.
 */

import { Connection } from './base.js';
import type { ExecOptions, ExecResult } from './base.js';
import { SSHAuthError, UnsupportedExecError } from './errors.js';
import { HTTPSClient } from './https-client.js';
import { SSHClient, type SSHCertCredentials } from './ssh-client.js';

export interface TrueNasConnectionOptions {
  hostname: string;
  baseUrl: string;
  apiToken?: string;
  insecure?: boolean;
  sshUser?: string;
  sshPort?: number;
  privateKeyPath: string;
  certPath: string;
  httpsClient?: HTTPSClient;
  sshClient?: SSHClient;
}

interface ExecDescriptor {
  method: string;
  path: string;
  body?: unknown;
}

export class TrueNasConnection extends Connection {
  protected readonly opts: TrueNasConnectionOptions;
  protected readonly httpsClient: HTTPSClient;
  protected readonly sshClient: SSHClient;

  constructor(platformId: string, opts: TrueNasConnectionOptions) {
    super(platformId);
    this.opts = opts;
    this.httpsClient =
      opts.httpsClient ??
      new HTTPSClient({
        baseUrl: opts.baseUrl,
        ...(opts.apiToken !== undefined ? { bearerToken: opts.apiToken } : {}),
        ...(opts.insecure !== undefined ? { insecure: opts.insecure } : {}),
      });
    this.sshClient = opts.sshClient ?? new SSHClient();
  }

  override async connect(): Promise<void> {
    this.lastUsedAt = Date.now();
    try {
      const r = await this.httpsClient.get('/api/v2.0/system/info', { timeoutMs: 5000 });
      if (r.status >= 200 && r.status < 300) {
        this.connected = true;
        this.capabilities = { transport: 'https', hostname: this.opts.hostname };
        return;
      }
      throw new Error(`REST status ${r.status}`);
    } catch {
      // Fall through to SSH on any REST failure.
    }
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
    if (!this.connected || this.capabilities === undefined) {
      throw new SSHAuthError('exec called before connect()');
    }
    this.lastUsedAt = Date.now();
    if (this.capabilities.transport === 'https') {
      const desc = parseDescriptor(command);
      const start = Date.now();
      const r = await this.httpsClient.request(
        desc.method,
        desc.path,
        desc.body,
        opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
      );
      return {
        stdout: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        stderr: '',
        exitCode: r.status >= 200 && r.status < 300 ? 0 : r.status,
        durationMs: Date.now() - start,
      };
    }
    return this.sshClient.execCommand(command, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
  }

  override async disconnect(): Promise<void> {
    if (this.capabilities?.transport === 'ssh') {
      try {
        await this.sshClient.disconnect();
      } catch {
        // best-effort
      }
    }
    this.connected = false;
  }
}

function parseDescriptor(command: string): ExecDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(command);
  } catch {
    throw new UnsupportedExecError(
      'TrueNasConnection.exec on REST transport requires a JSON descriptor {method, path, body?}',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { method?: unknown }).method !== 'string' ||
    typeof (parsed as { path?: unknown }).path !== 'string'
  ) {
    throw new UnsupportedExecError(
      'TrueNasConnection.exec descriptor must include string `method` and `path` fields',
    );
  }
  return parsed as ExecDescriptor;
}
