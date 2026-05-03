/**
 * MCPDiscovery: enumerates operator-installed `mcp-server-*` entries from
 * `~/.config/claude/.mcp.json` and exposes the subset that match the
 * homelab platform list. Implements SPEC-001-3-01 / TDD-001 §10.
 *
 * Behavior is read-only and best-effort: a missing or malformed file
 * yields an empty list (with a debug/warn log) so a misconfigured MCP
 * never blocks `discover`. The opt-out env var
 * `HOMELAB_DISABLE_MCP_DISCOVERY=1` short-circuits with `[]`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The set of homelab platforms recognized as having an `mcp-server-X` peer. */
export type HomelabPlatformId =
  | 'proxmox'
  | 'kubernetes'
  | 'docker'
  | 'unraid'
  | 'unifi'
  | 'truenas';

const HOMELAB_PLATFORM_IDS: ReadonlyArray<HomelabPlatformId> = [
  'proxmox',
  'kubernetes',
  'docker',
  'unraid',
  'unifi',
  'truenas',
];

/** Strict, case-sensitive matcher: `mcp-server-<homelab-platform-id>`. */
const SERVER_NAME_REGEX = /^mcp-server-(proxmox|kubernetes|docker|unraid|unifi|truenas)$/;

export interface MCPServerInfo {
  /** Full server key from `.mcp.json`, e.g. `"mcp-server-proxmox"`. */
  name: string;
  /** Suffix-derived platform id, e.g. `"proxmox"`. */
  platform: HomelabPlatformId;
  /** Joined command (and args) declared in `.mcp.json` for debug/audit. */
  command: string;
}

export interface MCPDiscoveryLogger {
  debug?(msg: string, ctx?: Record<string, unknown>): void;
  info?(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: MCPDiscoveryLogger = {};

export interface MCPDiscoveryOptions {
  /** Override config path (defaults to `~/.config/claude/.mcp.json`). */
  mcpConfigPath?: string;
  /** Override env (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Logger. Defaults to a silent stub. */
  logger?: MCPDiscoveryLogger;
}

/** Default location of the operator's MCP config. */
export function defaultMCPConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'claude', '.mcp.json');
}

/**
 * Discovers operator-installed `mcp-server-*` entries that map to homelab
 * platforms. Stateless: each call re-reads the config file.
 */
export class MCPDiscovery {
  private readonly mcpConfigPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: MCPDiscoveryLogger;
  /** Cached realpath of the config (resolved once per instance). */
  private resolvedPath: string | null = null;

  constructor(opts: MCPDiscoveryOptions = {}) {
    this.mcpConfigPath = opts.mcpConfigPath ?? defaultMCPConfigPath();
    this.env = opts.env ?? process.env;
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  /** Returns the list of installed `mcp-server-*` matching homelab platforms, sorted by platform. */
  async discover(): Promise<MCPServerInfo[]> {
    if (this.env['HOMELAB_DISABLE_MCP_DISCOVERY'] === '1') {
      this.logger.debug?.('MCP discovery disabled by env var');
      return [];
    }

    const resolved = await this.resolvePath();
    if (resolved === null) {
      this.logger.debug?.(`No .mcp.json found at ${this.mcpConfigPath}`);
      return [];
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolved, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.logger.debug?.(`No .mcp.json found at ${resolved}`);
        return [];
      }
      // Permission denied or other read failure: best-effort, degrade gracefully.
      this.logger.warn?.(
        `Unable to read .mcp.json at ${resolved}: ${(err as Error).message}`,
      );
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn?.(
        `Malformed .mcp.json; ignoring (${(err as Error).message})`,
      );
      return [];
    }

    if (parsed === null || typeof parsed !== 'object') {
      return [];
    }

    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === null || servers === undefined || typeof servers !== 'object') {
      return [];
    }

    const out: MCPServerInfo[] = [];
    for (const [name, raw_entry] of Object.entries(servers as Record<string, unknown>)) {
      const m = SERVER_NAME_REGEX.exec(name);
      if (m === null) continue;
      const platform = m[1] as HomelabPlatformId;
      const command = extractCommand(raw_entry);
      if (command === null) {
        this.logger.warn?.(
          `Skipping malformed mcp-server entry: ${name} (missing or empty command)`,
        );
        continue;
      }
      out.push({ name, platform, command });
    }

    out.sort((a, b) => a.platform.localeCompare(b.platform));
    if (out.length > 0) {
      this.logger.info?.(
        `Discovered ${out.length} MCP server(s) for homelab platforms: ${out
          .map((s) => s.platform)
          .join(', ')}`,
      );
    }
    return out;
  }

  /** Returns the MCPServerInfo for a given platform, or null if absent. */
  async getForPlatform(platform: HomelabPlatformId): Promise<MCPServerInfo | null> {
    const all = await this.discover();
    return all.find((s) => s.platform === platform) ?? null;
  }

  /** Test seam: enumerate the homelab platform ids the discovery filters on. */
  static knownPlatforms(): ReadonlyArray<HomelabPlatformId> {
    return HOMELAB_PLATFORM_IDS;
  }

  /**
   * Map an inventory `PlatformType` (e.g. `'proxmox-ve'`) to the
   * corresponding `HomelabPlatformId` (e.g. `'proxmox'`) the MCP server
   * naming uses, or null if no MCP server is defined for that platform.
   */
  static toHomelabPlatformId(
    platformType:
      | 'unraid'
      | 'proxmox-ve'
      | 'docker'
      | 'kubernetes'
      | 'docker-swarm'
      | 'unifi'
      | 'truenas',
  ): HomelabPlatformId | null {
    switch (platformType) {
      case 'proxmox-ve':
        return 'proxmox';
      case 'kubernetes':
        return 'kubernetes';
      case 'docker':
        return 'docker';
      case 'docker-swarm':
        // No mcp-server-docker-swarm; closest peer is mcp-server-docker.
        return 'docker';
      case 'unraid':
        return 'unraid';
      case 'unifi':
        return 'unifi';
      case 'truenas':
        return 'truenas';
      default:
        return null;
    }
  }

  /**
   * Resolve `mcpConfigPath` once via realpath (handles symlinked
   * `~/.config/claude`). Returns null if the path does not exist.
   */
  private async resolvePath(): Promise<string | null> {
    if (this.resolvedPath !== null) return this.resolvedPath;
    try {
      this.resolvedPath = await fs.realpath(this.mcpConfigPath);
      return this.resolvedPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // Other errors (e.g. permission to traverse parent dir): treat as
      // "not present" so discovery is best-effort.
      this.logger.debug?.(
        `realpath failed for ${this.mcpConfigPath}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

/**
 * Extract the `command` field from a `.mcp.json` server entry. Accepts
 * either a string `command` or a `command` array (joined with spaces).
 * Also tolerates `args: [...]` alongside a string command (the operator's
 * common pattern from the Claude docs).
 */
function extractCommand(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const obj = entry as { command?: unknown; args?: unknown };
  let parts: string[] = [];
  if (typeof obj.command === 'string') {
    if (obj.command.trim() === '') return null;
    parts.push(obj.command);
  } else if (Array.isArray(obj.command)) {
    for (const piece of obj.command) {
      if (typeof piece !== 'string') return null;
      parts.push(piece);
    }
    if (parts.length === 0) return null;
  } else {
    return null;
  }
  if (Array.isArray(obj.args)) {
    for (const a of obj.args) {
      if (typeof a === 'string') parts.push(a);
    }
  }
  return parts.join(' ');
}
