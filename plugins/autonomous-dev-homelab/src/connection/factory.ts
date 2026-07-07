/**
 * `createConnection`: switches on inventory entry `type` and instantiates
 * the correct `Connection` subclass with credentials wired through.
 * Implements SPEC-001-2-03 §"`src/connection/factory.ts`".
 *
 * This is intentionally a small, dependency-light shim: it does not load
 * inventory entries from disk (callers do) and it does not validate
 * entries beyond what the subclass constructors expect.
 */

import type { Connection } from './base.js';
import type { MCPClient } from './mcp-client.js';
import type { SSHClient } from './ssh-client.js';
import type { HTTPSClient } from './https-client.js';
import { ProxmoxConnection } from './proxmox.js';
import { DockerConnection } from './docker.js';
import { K8sConnection } from './k8s.js';
import { UnifiConnection } from './unifi.js';
import { TrueNasConnection } from './truenas.js';
import { UnraidConnection } from './unraid.js';
import type { PlatformType, Platform as InventoryEntry } from '../discovery/inventory-types.js';

export type { InventoryEntry };

export class UnknownPlatformError extends Error {
  public readonly platform: string;
  constructor(platform: string) {
    super(`Unknown platform type: ${platform}`);
    this.name = 'UnknownPlatformError';
    this.platform = platform;
  }
}

export interface FactoryDeps {
  mcpClient?: MCPClient;
  sshClient?: SSHClient;
  httpsClient?: HTTPSClient;
}

export type ConnectionFactory = (
  platformId: string,
  entry: InventoryEntry,
  deps?: FactoryDeps,
) => Connection;

/**
 * Pulls a string field from `entry.connection` with a default. We accept
 * `unknown` because the inventory `connection` map is open-shaped.
 */
function str(entry: InventoryEntry, key: string, fallback: string): string {
  const v = entry.connection?.[key];
  return typeof v === 'string' ? v : fallback;
}

function optStr(entry: InventoryEntry, key: string): string | undefined {
  const v = entry.connection?.[key];
  return typeof v === 'string' ? v : undefined;
}

function optBool(entry: InventoryEntry, key: string): boolean | undefined {
  const v = entry.connection?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function preferTransport(entry: InventoryEntry): 'mcp' | 'ssh' | undefined {
  const v = entry.connection?.['prefer'];
  return v === 'mcp' || v === 'ssh' ? v : undefined;
}

export const createConnection: ConnectionFactory = (platformId, entry, deps = {}) => {
  const type: PlatformType = entry.type;
  switch (type) {
    case 'proxmox-ve':
      return new ProxmoxConnection(platformId, mcpOrSshOpts(entry, deps));
    case 'docker':
      return new DockerConnection(platformId, mcpOrSshOpts(entry, deps));
    case 'kubernetes':
      return new K8sConnection(platformId, mcpOrSshOpts(entry, deps));
    case 'docker-swarm':
      // Swarm uses the same Docker MCP server / SSH path.
      return new DockerConnection(platformId, mcpOrSshOpts(entry, deps));
    case 'portainer':
      // Portainer is a management layer over Docker/Swarm; SSH/MCP access
      // goes to the underlying Docker host, so DockerConnection is correct.
      return new DockerConnection(platformId, mcpOrSshOpts(entry, deps));
    case 'unifi':
      return new UnifiConnection(platformId, {
        hostname: entry.ssh_host ?? entry.host,
        baseUrl: str(entry, 'base_url', `https://${entry.host}:${entry.port}`),
        ...(optStr(entry, 'https_token') !== undefined
          ? { bearerToken: optStr(entry, 'https_token')! }
          : {}),
        ...(optStr(entry, 'api_key') !== undefined ? { apiKey: optStr(entry, 'api_key')! } : {}),
        ...(optBool(entry, 'insecure') !== undefined ? { insecure: optBool(entry, 'insecure')! } : {}),
        ...(deps.httpsClient !== undefined ? { httpsClient: deps.httpsClient } : {}),
      });
    case 'truenas':
      return new TrueNasConnection(platformId, {
        hostname: entry.ssh_host ?? entry.host,
        baseUrl: str(entry, 'base_url', `https://${entry.host}:${entry.port}`),
        ...(optStr(entry, 'api_token') !== undefined
          ? { apiToken: optStr(entry, 'api_token')! }
          : {}),
        ...(optBool(entry, 'insecure') !== undefined ? { insecure: optBool(entry, 'insecure')! } : {}),
        ...(optStr(entry, 'ssh_user') !== undefined ? { sshUser: optStr(entry, 'ssh_user')! } : {}),
        ...(entry.ssh_port !== undefined ? { sshPort: entry.ssh_port } : {}),
        privateKeyPath: str(entry, 'ssh_key_path', ''),
        certPath: entry.connection?.ssh_cert_path !== undefined &&
          typeof entry.connection.ssh_cert_path === 'string'
          ? entry.connection.ssh_cert_path
          : '',
        ...(deps.httpsClient !== undefined ? { httpsClient: deps.httpsClient } : {}),
        ...(deps.sshClient !== undefined ? { sshClient: deps.sshClient } : {}),
      });
    case 'unraid':
      return new UnraidConnection(platformId, {
        hostname: entry.ssh_host ?? entry.host,
        ...(optStr(entry, 'ssh_user') !== undefined ? { sshUser: optStr(entry, 'ssh_user')! } : {}),
        ...(entry.ssh_port !== undefined ? { sshPort: entry.ssh_port } : {}),
        privateKeyPath: str(entry, 'ssh_key_path', ''),
        certPath: entry.connection?.ssh_cert_path !== undefined &&
          typeof entry.connection.ssh_cert_path === 'string'
          ? entry.connection.ssh_cert_path
          : '',
        ...(deps.sshClient !== undefined ? { sshClient: deps.sshClient } : {}),
      });
    default: {
      // Exhaustiveness check; unreachable when PlatformType is in sync.
      const _exhaustive: never = type;
      throw new UnknownPlatformError(_exhaustive as unknown as string);
    }
  }
};

function mcpOrSshOpts(
  entry: InventoryEntry,
  deps: FactoryDeps,
): {
  hostname: string;
  sshUser?: string;
  sshPort?: number;
  privateKeyPath: string;
  certPath: string;
  preferTransport?: 'mcp' | 'ssh';
  mcpClient?: MCPClient;
  sshClient?: SSHClient;
} {
  const certPath =
    entry.connection?.ssh_cert_path !== undefined &&
    typeof entry.connection.ssh_cert_path === 'string'
      ? entry.connection.ssh_cert_path
      : '';
  return {
    hostname: entry.ssh_host ?? entry.host,
    ...(optStr(entry, 'ssh_user') !== undefined ? { sshUser: optStr(entry, 'ssh_user')! } : {}),
    ...(entry.ssh_port !== undefined ? { sshPort: entry.ssh_port } : {}),
    privateKeyPath: str(entry, 'ssh_key_path', ''),
    certPath,
    ...(preferTransport(entry) !== undefined ? { preferTransport: preferTransport(entry)! } : {}),
    ...(deps.mcpClient !== undefined ? { mcpClient: deps.mcpClient } : {}),
    ...(deps.sshClient !== undefined ? { sshClient: deps.sshClient } : {}),
  };
}
