/**
 * `UnifiConnection`: HTTPS-only (no SSH, no MCP). Implements
 * SPEC-001-2-03 §"`src/connection/unifi.ts`".
 *
 * The `exec(command)` interface is preserved by interpreting the command
 * string as a JSON-encoded `{method, path, body?}` HTTPS descriptor.
 * Plain shell strings throw `UnsupportedExecError`.
 */

import { Connection } from './base.js';
import type { ExecOptions, ExecResult } from './base.js';
import { SSHAuthError, UnsupportedExecError } from './errors.js';
import { HTTPSClient } from './https-client.js';

export interface UnifiConnectionOptions {
  hostname: string;
  baseUrl: string;
  bearerToken?: string;
  apiKey?: string;
  insecure?: boolean;
  httpsClient?: HTTPSClient;
}

interface ExecDescriptor {
  method: string;
  path: string;
  body?: unknown;
}

export class UnifiConnection extends Connection {
  protected readonly opts: UnifiConnectionOptions;
  protected readonly httpsClient: HTTPSClient;

  constructor(platformId: string, opts: UnifiConnectionOptions) {
    super(platformId);
    this.opts = opts;
    this.httpsClient =
      opts.httpsClient ??
      new HTTPSClient({
        baseUrl: opts.baseUrl,
        ...(opts.bearerToken !== undefined ? { bearerToken: opts.bearerToken } : {}),
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.insecure !== undefined ? { insecure: opts.insecure } : {}),
      });
  }

  override async connect(): Promise<void> {
    this.lastUsedAt = Date.now();
    const r = await this.httpsClient.get('/api/self', { timeoutMs: 10_000 });
    if (r.status < 200 || r.status >= 300) {
      throw new SSHAuthError(`UniFi preflight failed with status ${r.status}`);
    }
    this.connected = true;
    this.capabilities = { transport: 'https', hostname: this.opts.hostname };
  }

  override async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.connected) {
      throw new SSHAuthError('exec called before connect()');
    }
    this.lastUsedAt = Date.now();
    const desc = parseDescriptor(command);
    const start = Date.now();
    const r = await this.httpsClient.request(
      desc.method,
      desc.path,
      desc.body,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
    );
    const durationMs = Date.now() - start;
    return {
      stdout: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      stderr: '',
      // Map non-2xx HTTP statuses to the exit-code field so callers can
      // branch without knowing the underlying transport.
      exitCode: r.status >= 200 && r.status < 300 ? 0 : r.status,
      durationMs,
    };
  }

  override async disconnect(): Promise<void> {
    // HTTPS is request-scoped; nothing to close.
    this.connected = false;
  }
}

function parseDescriptor(command: string): ExecDescriptor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(command);
  } catch {
    throw new UnsupportedExecError(
      'UnifiConnection.exec accepts only JSON-encoded HTTPS descriptors of shape {method, path, body?}; got non-JSON',
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { method?: unknown }).method !== 'string' ||
    typeof (parsed as { path?: unknown }).path !== 'string'
  ) {
    throw new UnsupportedExecError(
      'UnifiConnection.exec descriptor must include string `method` and `path` fields',
    );
  }
  const d = parsed as ExecDescriptor;
  return d;
}
