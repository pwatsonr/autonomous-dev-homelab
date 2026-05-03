/**
 * `ProxmoxConnection`: MCP-first via `mcp-server-proxmox`, SSH cert
 * fallback. Implements SPEC-001-2-02 §"`src/connection/proxmox.ts`".
 */

import { MCPOrSSHConnection, type MCPOrSSHOptions } from './shared-mcp-ssh.js';

export type ProxmoxConnectionOptions = MCPOrSSHOptions;

export class ProxmoxConnection extends MCPOrSSHConnection {
  constructor(platformId: string, opts: ProxmoxConnectionOptions) {
    super(platformId, opts);
  }

  protected override mcpServerName(): string {
    return 'mcp-server-proxmox';
  }
}
