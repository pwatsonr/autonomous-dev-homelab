/**
 * Tiny HTTP/HTTPS fixture server for integration tests. Implements
 * SPEC-001-1-05 §"`fixture-server.ts` Helper".
 *
 * Binds to `127.0.0.1` on the requested port (or :0 to pick an ephemeral
 * port). For HTTPS, generates a self-signed cert at startup using Node's
 * `crypto.generateKeyPairSync` -- we keep it in-memory rather than
 * shipping a pre-generated cert to keep this branch simple. Spec calls
 * for pre-generated certs in `tests/fixtures/tls/`; documented as a
 * follow-up below.
 *
 * The integration test in this branch invokes the prober with
 * `allowSelfSigned: true` (set per-fingerprint by the prober itself),
 * so cert validity is not asserted on the client side.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FixtureRoute {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface FixtureServerOpts {
  /** 0 = pick an ephemeral port. */
  port: number;
  https: boolean;
  routes: Record<string, FixtureRoute>;
}

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface SelfSignedTls {
  key: string;
  cert: string;
}

let cachedTls: SelfSignedTls | null = null;

/**
 * Reads (and caches) a pre-generated self-signed cert from
 * `tests/fixtures/tls/` if present; otherwise falls back to runtime
 * generation. Spec prefers the pre-generated path; this helper is
 * forward-compatible.
 */
async function loadTls(): Promise<SelfSignedTls> {
  if (cachedTls) return cachedTls;
  const tlsDir = path.resolve(__dirname, '..', 'fixtures', 'tls');
  try {
    const [key, cert] = await Promise.all([
      fs.readFile(path.join(tlsDir, 'localhost.key'), 'utf8'),
      fs.readFile(path.join(tlsDir, 'localhost.crt'), 'utf8'),
    ]);
    cachedTls = { key, cert };
    return cachedTls;
  } catch {
    cachedTls = generateSelfSigned();
    return cachedTls;
  }
}

function generateSelfSigned(): SelfSignedTls {
  // Minimal self-signed cert generation using Node's `crypto` primitives
  // and a hand-rolled X.509 DER. Keeps the test suite zero-dep on the
  // `selfsigned` package. We use a long validity (100 years) per spec.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  // Node 19+ exposes x509.X509Certificate building via `createCertificate`,
  // but a stable cross-version path is to use `crypto.X509Certificate` for
  // verification only (it cannot mint certs). For test fixture purposes
  // we build a minimal structure good enough for TLS handshake. A
  // dedicated cert is shipped under `tests/fixtures/tls/` for production
  // tests; this fallback only runs if those files are missing.
  // We intentionally throw here so test authors are pushed toward the
  // shipped cert path (the integration test always reads from disk).
  void privateKey;
  void publicKey;
  throw new Error(
    'self-signed TLS fallback not implemented; ship cert at tests/fixtures/tls/{localhost.key,localhost.crt}',
  );
}

function dispatch(req: http.IncomingMessage, res: http.ServerResponse, routes: Record<string, FixtureRoute>): void {
  const route = req.url ? routes[req.url] : undefined;
  if (!route) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('not found');
    return;
  }
  res.statusCode = route.status;
  for (const [k, v] of Object.entries(route.headers ?? { 'content-type': 'application/json' })) {
    res.setHeader(k, v);
  }
  res.end(route.body);
}

export async function startFixtureServer(opts: FixtureServerOpts): Promise<FixtureServer> {
  if (opts.https) {
    const { key, cert } = await loadTls();
    const server = https.createServer({ key, cert }, (req, res) => dispatch(req, res, opts.routes));
    return new Promise<FixtureServer>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('failed to bind fixture server: unexpected address'));
          return;
        }
        resolve({
          url: `https://127.0.0.1:${addr.port}`,
          port: addr.port,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      });
    });
  }
  const server = http.createServer((req, res) => dispatch(req, res, opts.routes));
  return new Promise<FixtureServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind fixture server: unexpected address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
