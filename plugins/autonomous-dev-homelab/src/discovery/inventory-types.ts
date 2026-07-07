/**
 * Inventory types matching `inventory-v1.json`. SPEC-001-1-03.
 *
 * Re-exports `PlatformType` so consumers can import it from a single
 * inventory module without reaching into the discovery types file.
 */

export type PlatformType =
  | 'unraid'
  | 'proxmox-ve'
  | 'docker'
  | 'kubernetes'
  | 'docker-swarm'
  | 'portainer'
  | 'unifi'
  | 'truenas';

export interface Connection {
  ssh_cert_path?: string;
  /**
   * MCP server name (e.g. `"mcp-server-proxmox"`) when the operator has
   * installed one for this platform; `null` when MCP discovery ran but
   * found none; absent (`undefined`) when discovery never ran.
   */
  mcp_endpoint?: string | null;
  [key: string]: unknown;
}

export interface Platform {
  id: string;
  type: PlatformType;
  host: string;
  port: number;
  ssh_host?: string;
  ssh_port?: number;
  discovered_at: string;
  last_seen: string;
  metadata?: Record<string, unknown>;
  connection?: Connection;
}

export interface InventoryFile {
  version: '1.0';
  platforms: Platform[];
}

/** Stable, narrow error codes raised by InventoryManager. */
export type InventoryErrorCode = 'DUPLICATE_ID' | 'NOT_FOUND' | 'INVALID_INVENTORY';

export class InventoryError extends Error {
  public readonly code: InventoryErrorCode;
  constructor(code: InventoryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'InventoryError';
  }
}
