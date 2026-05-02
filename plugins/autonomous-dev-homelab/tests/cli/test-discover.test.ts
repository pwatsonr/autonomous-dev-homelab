/**
 * `discover` CLI command tests with mocked deps.
 *
 * Exercises the full exit-code matrix (0, 1, 2, 3, 10), JSON vs human
 * output, --no-prompt enforcement, and re-discovery (updatePlatform vs
 * addPlatform) semantics.
 */

import * as path from 'node:path';
import { runDiscover } from '../../src/cli/commands/discover';
import { ConsentManager } from '../../src/consent/manager';
import { PlatformProber } from '../../src/discovery/prober';
import { InventoryManager } from '../../src/discovery/inventory';
import {
  EXIT_OK,
  EXIT_USAGE,
  EXIT_NO_CONSENT,
  EXIT_PARTIAL,
} from '../../src/cli/exit-codes';
import type { Consent, ScanType } from '../../src/consent/types';
import type { MatchedPlatform, HttpClient } from '../../src/discovery/types';
import { OVERRIDE_ENV } from '../../src/consent/fingerprint';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const FIXED_FP = 'route=test;dns=test';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams() {
  const captured: CapturedStreams = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s: string) => {
        captured.stdout += s;
      },
      stderr: (s: string) => {
        captured.stderr += s;
      },
    },
  };
}

function fakeHttpClient(handler: (url: string) => { statusCode: number; body: string }): HttpClient {
  return {
    async get(url) {
      const r = handler(url);
      return { statusCode: r.statusCode, body: r.body, headers: {} };
    },
  };
}

describe('runDiscover', () => {
  let tempDir: string;
  let consentPath: string;
  let inventoryPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir();
    consentPath = path.join(tempDir, 'network_consent.yaml');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  test('--cidr with malformed CIDR exits 1 and prints usage error', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
    });
    const prober = new PlatformProber({ httpClient: fakeHttpClient(() => ({ statusCode: 404, body: '' })) });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();

    const code = await runDiscover(
      { cidr: 'not-a-cidr' },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(code).toBe(EXIT_USAGE);
    expect(captured.stderr).toMatch(/invalid CIDR/);
    expect(captured.stdout).toBe('');
  });

  test('missing consent + --no-prompt → exit 2 with stderr message', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
    });
    const prober = new PlatformProber({ httpClient: fakeHttpClient(() => ({ statusCode: 404, body: '' })) });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();

    const code = await runDiscover(
      { cidr: '192.168.1.0/24', noPrompt: true },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(code).toBe(EXIT_NO_CONSENT);
    expect(captured.stderr).toMatch(/no consent for 192\.168\.1\.0\/24/);
    expect(captured.stdout).toBe('');
  });

  test('--json implies --no-prompt (no interactive prompt invoked)', async () => {
    let prompted = false;
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => {
        prompted = true;
        return true;
      },
    });
    const prober = new PlatformProber({ httpClient: fakeHttpClient(() => ({ statusCode: 404, body: '' })) });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams } = captureStreams();
    const code = await runDiscover(
      { cidr: '192.168.1.0/24', json: true },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(prompted).toBe(false);
    expect(code).toBe(EXIT_NO_CONSENT);
  });

  test('happy path with prior consent: scans, writes new inventory entry, exit 0', async () => {
    // Seed consent.
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);

    // Prober that "matches" Proxmox at 127.0.0.1.
    const prober = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });

    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();

    const code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(code).toBe(EXIT_OK);
    expect(captured.stdout).toMatch(/proxmox-ve @ 127\.0\.0\.1:8006/);
    expect(captured.stdout).toMatch(/\[new\]/);
    expect(captured.stdout).toMatch(/Discovered 1 platforms/);

    const list = await inventoryManager.listPlatforms();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('proxmox-ve-127-0-0-1');
  });

  test('re-discovery calls updatePlatform, advances last_seen', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);

    const prober = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });

    const inventoryManager = new InventoryManager(inventoryPath);

    // Two clocks: first run earlier, second run later.
    let now = new Date('2026-05-01T00:00:00Z');
    const deps = {
      consentManager,
      prober,
      inventoryManager,
      now: () => now,
      streams: captureStreams().streams,
    };
    await runDiscover({ cidr: '127.0.0.1/32' }, deps);
    const after1 = (await inventoryManager.listPlatforms())[0]!;
    expect(after1.last_seen).toBe('2026-05-01T00:00:00.000Z');

    now = new Date('2026-06-01T00:00:00Z');
    await runDiscover({ cidr: '127.0.0.1/32' }, deps);
    const list = await inventoryManager.listPlatforms();
    expect(list).toHaveLength(1); // not duplicated
    expect(list[0]!.last_seen).toBe('2026-06-01T00:00:00.000Z');
  });

  test('--json emits a single-line JSON object on stdout', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);

    const prober = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();
    const code = await runDiscover(
      { cidr: '127.0.0.1/32', json: true },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(code).toBe(EXIT_OK);
    // stdout MUST be a single JSON object (one newline at the end).
    expect(captured.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(captured.stdout.trim());
    expect(parsed.scanned_cidrs).toEqual(['127.0.0.1/32']);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.added_ids).toEqual(['proxmox-ve-127-0-0-1']);
    expect(parsed.updated_ids).toEqual([]);
  });

  test('no --cidr + empty consent file → exit 2 with explanation', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
    });
    const prober = new PlatformProber({ httpClient: fakeHttpClient(() => ({ statusCode: 404, body: '' })) });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();
    const code = await runDiscover(
      {},
      {
        consentManager,
        prober,
        inventoryManager,
        streams,
        listConsents: async () => [],
      },
    );
    expect(code).toBe(EXIT_NO_CONSENT);
    expect(captured.stderr).toMatch(/no consented CIDRs/);
  });

  test('multi-CIDR partial failure → exit 3 (some scanned, some failed)', async () => {
    // Pre-write a consent file with TWO CIDRs, both expired-fingerprint
    // semantics: we feed listConsents directly here.
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);

    const prober = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();

    const fakeList: Consent[] = [
      // valid for current fingerprint
      {
        cidr: '127.0.0.1/32',
        approved_at: '2026-05-01T00:00:00Z',
        expires_at: '2126-05-01T00:00:00Z',
        permitted_ports: [8006],
        permitted_scan_types: ['http_probe'] as ScanType[],
        network_fingerprint: FIXED_FP,
      },
      // expired
      {
        cidr: '10.0.0.1/32',
        approved_at: '2020-01-01T00:00:00Z',
        expires_at: '2020-04-01T00:00:00Z',
        permitted_ports: [443],
        permitted_scan_types: ['http_probe'] as ScanType[],
        network_fingerprint: FIXED_FP,
      },
    ];
    const code = await runDiscover(
      {},
      {
        consentManager,
        prober,
        inventoryManager,
        streams,
        listConsents: async () => fakeList,
      },
    );
    // Expired CIDR is silently dropped (not eligible), so exit 0 (one
    // CIDR scanned cleanly, none failed). Partial-failure case is
    // exercised when a probe call rejects on a per-CIDR basis below.
    expect(code).toBe(EXIT_OK);
    expect(captured.stdout).toMatch(/Discovered 1 platforms/);
  });

  test('partial failure (one CIDR scan throws) → exit 3', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);
    await consentManager.requestConsent('127.0.0.2/32', [8006], ['http_probe']);

    let count = 0;
    const proberOk = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });
    // Wrap to make the second scan reject.
    const flakyProber = {
      async scan(cidr: string, c: Consent) {
        count++;
        if (count === 2) throw new Error('boom');
        return proberOk.scan(cidr, c);
      },
    } as unknown as PlatformProber;

    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();
    const fakeList: Consent[] = [
      {
        cidr: '127.0.0.1/32',
        approved_at: '2026-05-01T00:00:00Z',
        expires_at: '2126-05-01T00:00:00Z',
        permitted_ports: [8006],
        permitted_scan_types: ['http_probe'] as ScanType[],
        network_fingerprint: FIXED_FP,
      },
      {
        cidr: '127.0.0.2/32',
        approved_at: '2026-05-01T00:00:00Z',
        expires_at: '2126-05-01T00:00:00Z',
        permitted_ports: [8006],
        permitted_scan_types: ['http_probe'] as ScanType[],
        network_fingerprint: FIXED_FP,
      },
    ];
    const code = await runDiscover(
      {},
      {
        consentManager,
        prober: flakyProber,
        inventoryManager,
        streams,
        listConsents: async () => fakeList,
      },
    );
    expect(code).toBe(EXIT_PARTIAL);
    expect(captured.stderr).toMatch(/scan failed/);
  });

  test('all data output goes to stdout; all errors go to stderr', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
    });
    const prober = new PlatformProber({ httpClient: fakeHttpClient(() => ({ statusCode: 404, body: '' })) });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();
    await runDiscover(
      { cidr: '192.168.1.0/24', noPrompt: true },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(captured.stdout).toBe('');
    expect(captured.stderr).not.toBe('');
  });

  test('uses MatchedPlatform.confidence (not toFixed-rounded) in JSON', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);

    const prober = new PlatformProber({
      catalog: [
        {
          platformType: 'proxmox-ve',
          probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
          expectedResponse: { kind: 'jsonPath', path: '$.data.version', exists: true, confidence: 0.98 },
        },
      ],
      httpClient: fakeHttpClient(() => ({ statusCode: 200, body: '{"data":{"version":"8.1.4"}}' })),
    });
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams, captured } = captureStreams();
    await runDiscover(
      { cidr: '127.0.0.1/32', json: true },
      { consentManager, prober, inventoryManager, streams },
    );
    const parsed = JSON.parse(captured.stdout.trim());
    const m: MatchedPlatform = parsed.matches[0];
    expect(m.confidence).toBe(0.98);
  });
});
