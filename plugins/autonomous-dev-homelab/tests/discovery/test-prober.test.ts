/**
 * PlatformProber unit tests with an injected fake HttpClient.
 *
 * Covers SPEC-001-1-02 ACs: match/no-match, multi-match per host,
 * permitted_scan_types gating, port filtering, concurrency cap, and
 * self-signed cert tolerance.
 */

import { PlatformProber } from '../../src/discovery/prober';
import { PLATFORM_FINGERPRINTS } from '../../src/discovery/fingerprints';
import type {
  Fingerprint,
  HttpClient,
  HttpClientGetOpts,
  HttpResponse,
} from '../../src/discovery/types';
import type { Consent } from '../../src/consent/types';

interface CallRecord {
  url: string;
  opts: HttpClientGetOpts;
}

interface FakeHttpClientResult {
  client: HttpClient;
  calls: CallRecord[];
  inFlightPeak(): number;
}

function fakeHttpClient(
  responder: (url: string) => Promise<HttpResponse>,
): FakeHttpClientResult {
  const calls: CallRecord[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    calls,
    inFlightPeak: () => peak,
    client: {
      async get(url, opts) {
        calls.push({ url, opts });
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        try {
          return await responder(url);
        } finally {
          inFlight--;
        }
      },
    },
  };
}

const PROXMOX_FP = PLATFORM_FINGERPRINTS.find((fp) => fp.platformType === 'proxmox-ve')!;
const DOCKER_FP = PLATFORM_FINGERPRINTS.find((fp) => fp.platformType === 'docker')!;
const K8S_FP = PLATFORM_FINGERPRINTS.find((fp) => fp.platformType === 'kubernetes')!;

function consentFor(ports: number[], scanTypes: ('http_probe' | 'ssh_probe' | 'tcp_connect')[]): Consent {
  return {
    cidr: '127.0.0.1/32',
    approved_at: '2026-05-01T00:00:00Z',
    expires_at: '2126-05-01T00:00:00Z',
    permitted_ports: ports,
    permitted_scan_types: scanTypes,
  };
}

describe('PlatformProber', () => {
  test('returns one match for a Proxmox-shaped response', async () => {
    const fake = fakeHttpClient(async (url) => {
      if (url.includes(':8006/api2/json/version')) {
        return {
          statusCode: 200,
          body: '{"data":{"version":"8.1.4"}}',
          headers: {},
        };
      }
      return { statusCode: 404, body: '', headers: {} };
    });
    const prober = new PlatformProber({
      catalog: [PROXMOX_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([8006], ['http_probe']));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.platformType).toBe('proxmox-ve');
    expect(matches[0]!.confidence).toBe(0.98);
  });

  test('returns [] when no fingerprint matches (404 from server)', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 404,
      body: '',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [PROXMOX_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([8006], ['http_probe']));
    expect(matches).toEqual([]);
  });

  test('multiple matches on a single host (Docker + Kubernetes)', async () => {
    const fake = fakeHttpClient(async (url) => {
      if (url.includes(':2375/_ping')) {
        return { statusCode: 200, body: 'OK', headers: {} };
      }
      if (url.includes(':6443/version')) {
        return {
          statusCode: 200,
          body: '{"gitVersion":"v1.29.0"}',
          headers: {},
        };
      }
      return { statusCode: 404, body: '', headers: {} };
    });
    const prober = new PlatformProber({
      catalog: [DOCKER_FP, K8S_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan(
      '127.0.0.1/32',
      consentFor([2375, 6443], ['http_probe']),
    );
    expect(matches.map((m) => m.platformType).sort()).toEqual(['docker', 'kubernetes']);
  });

  test('returns [] (no HTTP calls) when http_probe is not in permitted_scan_types', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 200,
      body: 'OK',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [DOCKER_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([2375], ['tcp_connect']));
    expect(matches).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  test('permitted_ports filter trims fingerprints', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 200,
      body: 'OK',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [DOCKER_FP, PROXMOX_FP],
      httpClient: fake.client,
    });
    // Only Docker port permitted; Proxmox fingerprint is dropped.
    await prober.scan('127.0.0.1/32', consentFor([2375], ['http_probe']));
    expect(fake.calls.every((c) => c.url.includes(':2375/'))).toBe(true);
  });

  test('4xx/5xx responses are not matches even if body would match', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 500,
      body: 'OK',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [DOCKER_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([2375], ['http_probe']));
    expect(matches).toEqual([]);
  });

  test('http client rejection is silently absorbed (no throw, no match)', async () => {
    const fake = fakeHttpClient(async () => {
      throw new Error('ECONNREFUSED');
    });
    const prober = new PlatformProber({
      catalog: [DOCKER_FP],
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([2375], ['http_probe']));
    expect(matches).toEqual([]);
  });

  test('concurrency cap: max in-flight ≤ configured concurrency', async () => {
    // Build a /24 worth of jobs then assert peak in-flight stays under cap.
    let resolveAll: (() => void) | null = null;
    const allReady = new Promise<void>((r) => {
      resolveAll = r;
    });
    const fake = fakeHttpClient(async () => {
      // Each request waits on `allReady` so they all stack up in-flight
      // before any resolves.
      await allReady;
      return { statusCode: 404, body: '', headers: {} };
    });
    const prober = new PlatformProber({
      catalog: [DOCKER_FP],
      concurrency: 5,
      httpClient: fake.client,
    });
    const scanPromise = prober.scan(
      '192.168.1.0/24',
      consentFor([2375], ['http_probe']),
    );
    // Yield enough event-loop turns for the prober to ramp up.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fake.inFlightPeak()).toBeLessThanOrEqual(5);
    resolveAll!();
    await scanPromise;
    expect(fake.inFlightPeak()).toBeLessThanOrEqual(5);
  });

  test('https probes pass allowSelfSigned: true', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 200,
      body: '{"data":{"version":"8.1.4"}}',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [PROXMOX_FP],
      httpClient: fake.client,
    });
    await prober.scan('127.0.0.1/32', consentFor([8006], ['http_probe']));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.opts.allowSelfSigned).toBe(true);
  });

  test('catalog with no port matching consent yields []', async () => {
    const fake = fakeHttpClient(async () => ({
      statusCode: 200,
      body: 'OK',
      headers: {},
    }));
    const prober = new PlatformProber({
      catalog: [DOCKER_FP], // port 2375
      httpClient: fake.client,
    });
    const matches = await prober.scan('127.0.0.1/32', consentFor([443], ['http_probe']));
    expect(matches).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
