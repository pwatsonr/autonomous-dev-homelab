/**
 * PlatformProber: scans a CIDR for known homelab platforms.
 *
 * Implements SPEC-001-1-02. Consumes a `Consent` (from SPEC-001-1-01) as
 * immutable input and probes every host in the CIDR against every
 * fingerprint whose port is permitted by the consent. Returns one
 * `MatchedPlatform` per (ip, port, fingerprint) match.
 *
 * Behavioral guarantees:
 * - Skips probes whose port is not in `consent.permitted_ports`.
 * - Returns [] if `consent.permitted_scan_types` does not include
 *   `'http_probe'`. (No HTTP requests are issued in that case.)
 * - At most `concurrency` (default 50) HTTP requests in flight at once.
 * - HTTPS probes tolerate self-signed certs (homelab platforms ubiquitously
 *   ship them).
 * - 4xx/5xx responses do not count as matches even if the body matches the
 *   regex/jsonPath. Only 2xx is evaluated.
 * - A match against one IP does not short-circuit other fingerprints; a
 *   single host can match multiple platforms (e.g., Docker + K8s).
 * - Timeouts and HTTP errors are absorbed silently (no match, no throw).
 */

import type { Consent } from '../consent/types.js';
import { enumerateHosts } from './cidr.js';
import { PLATFORM_FINGERPRINTS, PROBER_USER_AGENT } from './fingerprints.js';
import { NodeHttpClient } from './http-client.js';
import { jsonPathLookup } from './json-path.js';
import type {
  ExpectedResponse,
  Fingerprint,
  HttpClient,
  HttpResponse,
  MatchedPlatform,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CONCURRENCY = 50;
const RESPONSE_SNIPPET_LEN = 200;

export interface PlatformProberOpts {
  catalog?: Fingerprint[];
  concurrency?: number;
  httpClient?: HttpClient;
}

interface ProbeJob {
  ip: string;
  fingerprint: Fingerprint;
}

/** Build URL for a probe against a specific host. */
function buildUrl(ip: string, fp: Fingerprint): string {
  return `${fp.probe.protocol}://${ip}:${fp.probe.port}${fp.probe.path}`;
}

/** Returns true if the response body satisfies the expectedResponse matcher. */
function evaluateResponse(body: string, expected: ExpectedResponse): boolean {
  if (expected.kind === 'regex') {
    try {
      const re = new RegExp(expected.pattern, expected.flags);
      return re.test(body);
    } catch {
      return false;
    }
  }
  // jsonPath
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  let value: unknown;
  try {
    value = jsonPathLookup(parsed, expected.path);
  } catch {
    return false;
  }
  if (expected.exists === true) {
    return value !== undefined;
  }
  if ('equals' in expected) {
    return value === expected.equals;
  }
  return false;
}

/**
 * Async semaphore: at most `max` `acquire()` holders at any time.
 * Used to cap in-flight HTTP requests in the prober.
 */
class Semaphore {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.inFlight++;
    return () => this.release();
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export class PlatformProber {
  private readonly catalog: Fingerprint[];
  private readonly concurrency: number;
  private readonly httpClient: HttpClient;

  constructor(opts: PlatformProberOpts = {}) {
    this.catalog = opts.catalog ?? PLATFORM_FINGERPRINTS;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.httpClient = opts.httpClient ?? new NodeHttpClient();
  }

  async scan(cidr: string, consent: Consent): Promise<MatchedPlatform[]> {
    if (!consent.permitted_scan_types.includes('http_probe')) {
      return [];
    }
    const allowedPorts = new Set(consent.permitted_ports);
    const applicableFingerprints = this.catalog.filter((fp) => allowedPorts.has(fp.probe.port));
    if (applicableFingerprints.length === 0) {
      return [];
    }

    const jobs: ProbeJob[] = [];
    for (const ip of enumerateHosts(cidr)) {
      for (const fp of applicableFingerprints) {
        jobs.push({ ip, fingerprint: fp });
      }
    }

    const semaphore = new Semaphore(this.concurrency);
    const matches: MatchedPlatform[] = [];

    await Promise.all(
      jobs.map(async (job) => {
        const release = await semaphore.acquire();
        try {
          const match = await this.runProbe(job);
          if (match) matches.push(match);
        } finally {
          release();
        }
      }),
    );

    return matches;
  }

  private async runProbe(job: ProbeJob): Promise<MatchedPlatform | null> {
    const { ip, fingerprint } = job;
    const url = buildUrl(ip, fingerprint);
    const headers: Record<string, string> = {
      'User-Agent': PROBER_USER_AGENT,
      ...(fingerprint.probe.headers ?? {}),
    };
    const timeoutMs = fingerprint.probe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowSelfSigned = fingerprint.probe.protocol === 'https';
    let response: HttpResponse;
    try {
      response = await this.httpClient.get(url, { headers, timeoutMs, allowSelfSigned });
    } catch {
      // Timeout, connection refused, ECONNRESET, etc. — no match.
      return null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }
    if (!evaluateResponse(response.body, fingerprint.expectedResponse)) {
      return null;
    }
    return {
      platformType: fingerprint.platformType,
      ip,
      port: fingerprint.probe.port,
      protocol: fingerprint.probe.protocol,
      confidence: fingerprint.expectedResponse.confidence,
      matchedAt: new Date().toISOString(),
      responseSnippet: response.body.slice(0, RESPONSE_SNIPPET_LEN),
    };
  }
}
