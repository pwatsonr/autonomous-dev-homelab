/**
 * Default HTTP/HTTPS client implementation for the prober.
 *
 * Implements the `HttpClient` interface from SPEC-001-1-02 using Node's
 * built-in `http`/`https` modules. No third-party deps. Tolerates
 * self-signed certs when `allowSelfSigned: true` is passed (homelab
 * platforms ubiquitously ship self-signed certs).
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { HttpClient, HttpClientGetOpts, HttpResponse } from './types.js';

export class TimeoutError extends Error {
  public readonly code = 'TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class NodeHttpClient implements HttpClient {
  async get(rawUrl: string, opts: HttpClientGetOpts): Promise<HttpResponse> {
    const url = new URL(rawUrl);
    const isHttps = url.protocol === 'https:';
    return new Promise<HttpResponse>((resolve, reject) => {
      const requestOpts: https.RequestOptions = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? '443' : '80'),
        path: `${url.pathname}${url.search}`,
        headers: opts.headers,
        ...(isHttps ? { rejectUnauthorized: !opts.allowSelfSigned } : {}),
      };
      const lib = isHttps ? https : http;
      const req = lib.request(requestOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(',');
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers,
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new TimeoutError(`request to ${rawUrl} timed out after ${opts.timeoutMs}ms`));
      });
      req.end();
    });
  }
}
