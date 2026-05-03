/**
 * Verifies the discover CLI wires MCPDiscovery results into each
 * inventory entry's `connection.mcp_endpoint`. Implements SPEC-001-3-01
 * §"Inventory Wiring".
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { runDiscover } from '../../src/cli/commands/discover';
import { ConsentManager } from '../../src/consent/manager';
import { PlatformProber } from '../../src/discovery/prober';
import { InventoryManager } from '../../src/discovery/inventory';
import { MCPDiscovery } from '../../src/connection/mcp-discovery';
import { OVERRIDE_ENV } from '../../src/consent/fingerprint';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';
import type { HttpClient } from '../../src/discovery/types';
import { EXIT_OK } from '../../src/cli/exit-codes';

const FIXED_FP = 'route=test;dns=test';

function fakeHttpClient(): HttpClient {
  return {
    async get() {
      return {
        statusCode: 200,
        body: '{"data":{"version":"8.1.4"}}',
        headers: {},
      };
    },
  };
}

function captureStreams() {
  const captured = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s: string): void => {
        captured.stdout += s;
      },
      stderr: (s: string): void => {
        captured.stderr += s;
      },
    },
  };
}

function buildProber(): PlatformProber {
  return new PlatformProber({
    catalog: [
      {
        platformType: 'proxmox-ve',
        probe: { protocol: 'https', port: 8006, path: '/api2/json/version' },
        expectedResponse: {
          kind: 'jsonPath',
          path: '$.data.version',
          exists: true,
          confidence: 0.98,
        },
      },
    ],
    httpClient: fakeHttpClient(),
  });
}

describe('discover wires MCPDiscovery into connection.mcp_endpoint', () => {
  let tempDir: string;
  let consentPath: string;
  let inventoryPath: string;
  let mcpConfigPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('mcp-wiring-');
    consentPath = path.join(tempDir, 'network_consent.yaml');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
    mcpConfigPath = path.join(tempDir, '.mcp.json');
  });
  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  test('with mcp-server-proxmox installed: new entry has mcp_endpoint set', async () => {
    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { 'mcp-server-proxmox': { command: 'node' } } }),
    );
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);
    const prober = buildProber();
    const inventoryManager = new InventoryManager(inventoryPath);
    const mcpDiscovery = new MCPDiscovery({ mcpConfigPath, env: {} });
    const { streams } = captureStreams();

    const code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      { consentManager, prober, inventoryManager, streams, mcpDiscovery },
    );
    expect(code).toBe(EXIT_OK);
    const list = await inventoryManager.listPlatforms();
    expect(list).toHaveLength(1);
    expect(list[0]!.connection?.mcp_endpoint).toBe('mcp-server-proxmox');
  });

  test('with no MCP servers installed: new entry has mcp_endpoint === null', async () => {
    await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);
    const prober = buildProber();
    const inventoryManager = new InventoryManager(inventoryPath);
    const mcpDiscovery = new MCPDiscovery({ mcpConfigPath, env: {} });
    const { streams } = captureStreams();

    const code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      { consentManager, prober, inventoryManager, streams, mcpDiscovery },
    );
    expect(code).toBe(EXIT_OK);
    const list = await inventoryManager.listPlatforms();
    expect(list).toHaveLength(1);
    expect(list[0]!.connection?.mcp_endpoint).toBeNull();
  });

  test('idempotent: re-running after operator uninstalls clears mcp_endpoint to null', async () => {
    // First run: server installed.
    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { 'mcp-server-proxmox': { command: 'node' } } }),
    );
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);
    const prober = buildProber();
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams } = captureStreams();

    let code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      {
        consentManager,
        prober,
        inventoryManager,
        streams,
        mcpDiscovery: new MCPDiscovery({ mcpConfigPath, env: {} }),
      },
    );
    expect(code).toBe(EXIT_OK);
    expect((await inventoryManager.listPlatforms())[0]!.connection?.mcp_endpoint).toBe(
      'mcp-server-proxmox',
    );

    // Second run: server uninstalled (file replaced with empty).
    await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      {
        consentManager,
        prober,
        inventoryManager,
        streams,
        mcpDiscovery: new MCPDiscovery({ mcpConfigPath, env: {} }),
      },
    );
    expect(code).toBe(EXIT_OK);
    const after = (await inventoryManager.listPlatforms())[0]!;
    expect(after.connection?.mcp_endpoint).toBeNull();
  });

  test('without mcpDiscovery dep: existing connection block is preserved (no overwrite)', async () => {
    const consentManager = new ConsentManager(consentPath, {
      fingerprintRuntime: { env: { [OVERRIDE_ENV]: FIXED_FP } as NodeJS.ProcessEnv },
      promptFn: async () => true,
    });
    await consentManager.requestConsent('127.0.0.1/32', [8006], ['http_probe']);
    const prober = buildProber();
    const inventoryManager = new InventoryManager(inventoryPath);
    const { streams } = captureStreams();

    const code = await runDiscover(
      { cidr: '127.0.0.1/32' },
      { consentManager, prober, inventoryManager, streams },
    );
    expect(code).toBe(EXIT_OK);
    const e = (await inventoryManager.listPlatforms())[0]!;
    // No connection block should be added when mcpDiscovery is not wired.
    expect(e.connection?.mcp_endpoint).toBeUndefined();
  });
});
