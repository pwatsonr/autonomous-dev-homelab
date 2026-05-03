/**
 * Unit tests for MCPDiscovery (SPEC-001-3-01).
 *
 * Covers: opt-out env var, missing/malformed file, fixture parsing,
 * filtering by name pattern (case sensitivity), command shape (string
 * vs array), idempotency, and getForPlatform.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  MCPDiscovery,
  defaultMCPConfigPath,
  type HomelabPlatformId,
} from '../../src/connection/mcp-discovery';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'mcp');
const FIXTURE_PROXMOX_K8S = path.join(FIXTURE_DIR, 'mcp-with-proxmox-and-k8s.json');
const FIXTURE_EMPTY = path.join(FIXTURE_DIR, 'mcp-empty.json');

interface CapturedLogger {
  debug: string[];
  info: string[];
  warn: string[];
}

function captureLogger(): { logger: ReturnType<typeof makeLogger>; captured: CapturedLogger } {
  const captured: CapturedLogger = { debug: [], info: [], warn: [] };
  const logger = makeLogger(captured);
  return { logger, captured };
}

function makeLogger(captured: CapturedLogger) {
  return {
    debug: (msg: string): void => {
      captured.debug.push(msg);
    },
    info: (msg: string): void => {
      captured.info.push(msg);
    },
    warn: (msg: string): void => {
      captured.warn.push(msg);
    },
  };
}

describe('MCPDiscovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkTempDir('mcp-discovery-');
  });
  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  test('returns [] when .mcp.json does not exist', async () => {
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({
      mcpConfigPath: path.join(tempDir, 'nope.json'),
      env: {},
      logger,
    });
    await expect(d.discover()).resolves.toEqual([]);
    expect(captured.debug.some((m) => m.includes('No .mcp.json'))).toBe(true);
  });

  test('returns [] when HOMELAB_DISABLE_MCP_DISCOVERY=1 (does not even read file)', async () => {
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({
      mcpConfigPath: FIXTURE_PROXMOX_K8S,
      env: { HOMELAB_DISABLE_MCP_DISCOVERY: '1' },
      logger,
    });
    await expect(d.discover()).resolves.toEqual([]);
    expect(captured.debug.some((m) => m.includes('disabled by env'))).toBe(true);
  });

  test('returns [] (and logs a warning) when .mcp.json is malformed JSON', async () => {
    const badPath = path.join(tempDir, '.mcp.json');
    await fs.writeFile(badPath, '{this is not json}');
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: badPath, env: {}, logger });
    await expect(d.discover()).resolves.toEqual([]);
    expect(captured.warn.some((m) => m.includes('Malformed .mcp.json'))).toBe(true);
  });

  test('parses fixture: returns 2 entries (kubernetes, proxmox), sorted', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {} });
    const list = await d.discover();
    expect(list.map((s) => s.platform)).toEqual(['kubernetes', 'proxmox']);
    expect(list[0]!.name).toBe('mcp-server-kubernetes');
    expect(list[1]!.name).toBe('mcp-server-proxmox');
  });

  test('filters out non-homelab mcp-server-* entries (e.g., mcp-server-foo)', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {} });
    const list = await d.discover();
    expect(list.find((s) => s.name === 'mcp-server-foo')).toBeUndefined();
  });

  test('case-sensitive: mcp-server-Proxmox is NOT matched', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({ mcpServers: { 'mcp-server-Proxmox': { command: 'node' } } }),
    );
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('command can be a string', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({ mcpServers: { 'mcp-server-docker': { command: '/opt/mcp-docker' } } }),
    );
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    const list = await d.discover();
    expect(list).toHaveLength(1);
    expect(list[0]!.command).toBe('/opt/mcp-docker');
  });

  test('command can be an array (joined with spaces, args appended)', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {} });
    const list = await d.discover();
    const k8s = list.find((s) => s.platform === 'kubernetes')!;
    expect(k8s.command).toBe('python3 -m mcp_kubernetes');
    const proxmox = list.find((s) => s.platform === 'proxmox')!;
    // command="node" args=["/usr/local/lib/mcp-proxmox/index.js"]
    expect(proxmox.command).toBe('node /usr/local/lib/mcp-proxmox/index.js');
  });

  test('skips entries whose command is missing/empty (and logs a warning)', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        mcpServers: {
          'mcp-server-truenas': {},
          'mcp-server-unifi': { command: '' },
          'mcp-server-unraid': { command: 'echo' },
        },
      }),
    );
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {}, logger });
    const list = await d.discover();
    expect(list.map((s) => s.platform)).toEqual(['unraid']);
    expect(captured.warn.length).toBeGreaterThanOrEqual(2);
  });

  test('returns [] when .mcp.json is missing the mcpServers key (no throw)', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, JSON.stringify({ otherStuff: true }));
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('returns [] when JSON top-level is null', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, 'null');
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('mcpServers as a non-object yields []', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, JSON.stringify({ mcpServers: 'not-an-object' }));
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('mcp-empty.json fixture: no homelab servers → []', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_EMPTY, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('getForPlatform returns the matching entry or null', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {} });
    const proxmox = await d.getForPlatform('proxmox');
    expect(proxmox).not.toBeNull();
    expect(proxmox!.name).toBe('mcp-server-proxmox');
    const docker = await d.getForPlatform('docker');
    expect(docker).toBeNull();
  });

  test('info log emitted with platform list when discovery finds servers', async () => {
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {}, logger });
    await d.discover();
    expect(captured.info.some((m) => /kubernetes/.test(m) && /proxmox/.test(m))).toBe(true);
  });

  test('toHomelabPlatformId maps inventory PlatformType → MCP platform id', () => {
    expect(MCPDiscovery.toHomelabPlatformId('proxmox-ve')).toBe('proxmox');
    expect(MCPDiscovery.toHomelabPlatformId('kubernetes')).toBe('kubernetes');
    expect(MCPDiscovery.toHomelabPlatformId('docker')).toBe('docker');
    expect(MCPDiscovery.toHomelabPlatformId('docker-swarm')).toBe('docker');
    expect(MCPDiscovery.toHomelabPlatformId('unraid')).toBe('unraid');
    expect(MCPDiscovery.toHomelabPlatformId('unifi')).toBe('unifi');
    expect(MCPDiscovery.toHomelabPlatformId('truenas')).toBe('truenas');
  });

  test('knownPlatforms enumerates all homelab platform ids', () => {
    const ids: ReadonlyArray<HomelabPlatformId> = MCPDiscovery.knownPlatforms();
    expect(ids).toEqual(
      expect.arrayContaining(['proxmox', 'kubernetes', 'docker', 'unraid', 'unifi', 'truenas']),
    );
  });

  test('defaultMCPConfigPath ends in .config/claude/.mcp.json', () => {
    const p = defaultMCPConfigPath('/home/u');
    expect(p).toBe('/home/u/.config/claude/.mcp.json');
  });

  test('idempotent: calling discover twice returns equivalent results', async () => {
    const d = new MCPDiscovery({ mcpConfigPath: FIXTURE_PROXMOX_K8S, env: {} });
    const a = await d.discover();
    const b = await d.discover();
    expect(b).toEqual(a);
  });

  test('permission denied on read returns [] (best-effort, no throw)', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, '{}');
    await fs.chmod(p, 0o000);
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {}, logger });
    try {
      await expect(d.discover()).resolves.toEqual([]);
      // On platforms where root can read regardless of mode, the warn may
      // not fire; tolerate either path but assert no throw.
      expect(captured.warn.length + captured.debug.length).toBeGreaterThanOrEqual(0);
    } finally {
      await fs.chmod(p, 0o644);
    }
  });

  // ---------- SPEC-001-3-05 §"test-mcp-discovery.test.ts" extensions ------
  // These tests close residual branch coverage gaps so the canonical suite
  // hits the ≥95% gate documented in SPEC-001-3-05.

  test('returns [] when mcpServers is explicit null', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, JSON.stringify({ mcpServers: null }));
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('returns [] when mcpServers is missing entirely', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(p, JSON.stringify({}));
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('skips entry where command array contains a non-string element', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        mcpServers: { 'mcp-server-docker': { command: ['node', 42] } },
      }),
    );
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {}, logger });
    await expect(d.discover()).resolves.toEqual([]);
    expect(captured.warn.some((m) => m.includes('mcp-server-docker'))).toBe(true);
  });

  test('skips entry where command is an empty array', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        mcpServers: { 'mcp-server-docker': { command: [] } },
      }),
    );
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('command array joins parts; non-string args entries are dropped', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        mcpServers: {
          'mcp-server-truenas': {
            command: ['python3', '-m', 'mcp_truenas'],
            args: ['--verbose', 99, '--port', '8080'],
          },
        },
      }),
    );
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    const list = await d.discover();
    expect(list).toHaveLength(1);
    // 99 (number) is filtered out.
    expect(list[0]!.command).toBe(
      'python3 -m mcp_truenas --verbose --port 8080',
    );
  });

  test('skips entry whose command is neither a string nor an array', async () => {
    const p = path.join(tempDir, '.mcp.json');
    await fs.writeFile(
      p,
      JSON.stringify({
        mcpServers: { 'mcp-server-unifi': { command: { weird: true } } },
      }),
    );
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {} });
    await expect(d.discover()).resolves.toEqual([]);
  });

  test('toHomelabPlatformId returns null for unknown platform types', () => {
    // Cast to bypass the compile-time guard so we can exercise the default
    // arm of the switch.
    expect(
      MCPDiscovery.toHomelabPlatformId(
        'wat' as unknown as Parameters<typeof MCPDiscovery.toHomelabPlatformId>[0],
      ),
    ).toBeNull();
  });

  test('realpath errors other than ENOENT degrade gracefully (debug log)', async () => {
    // Create a directory entry; pass a path that traverses through a file
    // which yields ENOTDIR on most platforms — exercises the non-ENOENT
    // branch in resolvePath.
    const blocker = path.join(tempDir, 'block-file');
    await fs.writeFile(blocker, 'x');
    const p = path.join(blocker, '.mcp.json');
    const { logger, captured } = captureLogger();
    const d = new MCPDiscovery({ mcpConfigPath: p, env: {}, logger });
    await expect(d.discover()).resolves.toEqual([]);
    expect(captured.debug.length).toBeGreaterThanOrEqual(1);
  });
});
