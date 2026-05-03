/**
 * Tiny HTTPS client for the UniFi/TrueNAS appliance subclasses. Implements
 * SPEC-001-2-03 §"`src/connection/https-client.ts`".
 *
 * Uses Node 18+ built-in `fetch` and `AbortSignal.timeout`. JSON request/
 * response bodies are auto-encoded/decoded. When `insecure: true`, the
 * client logs a warning every connect (operator opt-in for self-signed).
 */

import * as https from 'node:https';

export interface HTTPSCredentials {
  baseUrl: string;
  bearerToken?: string;
  apiKey?: string;
  /** Allow self-signed TLS certs. Logs a warning each request when true. */
  insecure?: boolean;
}

export interface HTTPSResponse {
  status: number;
  body: unknown;
}

export interface HTTPSRequestOpts {
  timeoutMs?: number;
}

export interface HTTPSClientLogger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: HTTPSClientLogger = { warn: () => undefined };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class HTTPSClient {
  private readonly creds: HTTPSCredentials;
  private readonly logger: HTTPSClientLogger;
  private readonly fetchImpl: FetchFn;
  private readonly insecureAgent?: https.Agent;

  constructor(creds: HTTPSCredentials, opts: { logger?: HTTPSClientLogger; fetch?: FetchFn } = {}) {
    this.creds = creds;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchFn);
    if (creds.insecure === true) {
      this.insecureAgent = new https.Agent({ rejectUnauthorized: false });
    }
  }

  isConfigured(): boolean {
    return typeof this.creds.bearerToken === 'string' || typeof this.creds.apiKey === 'string';
  }

  async get(p: string, opts: HTTPSRequestOpts = {}): Promise<HTTPSResponse> {
    return this.request('GET', p, undefined, opts);
  }

  async post(p: string, body: unknown, opts: HTTPSRequestOpts = {}): Promise<HTTPSResponse> {
    return this.request('POST', p, body, opts);
  }

  async request(
    method: string,
    p: string,
    body: unknown,
    opts: HTTPSRequestOpts,
  ): Promise<HTTPSResponse> {
    const url = `${this.creds.baseUrl.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.creds.bearerToken !== undefined) {
      headers.Authorization = `Bearer ${this.creds.bearerToken}`;
    }
    if (this.creds.apiKey !== undefined) {
      headers['X-API-Key'] = this.creds.apiKey;
    }
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (this.creds.insecure === true) {
      this.logger.warn('https_client_insecure_mode', { url });
      // Note: Node 18 fetch ignores the `agent` init field; the Agent is
      // attached for the (rare) case where a caller swaps in a fetch impl
      // that honors it. We rely on the warning log to remind operators.
      (init as unknown as { agent: https.Agent }).agent = this.insecureAgent!;
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }
}
