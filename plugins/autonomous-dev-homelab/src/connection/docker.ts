/**
 * `DockerConnection`: MCP-first via `mcp-server-docker`, SSH `docker`
 * CLI fallback. Implements SPEC-001-2-02 §"`src/connection/docker.ts`".
 *
 * Note: targets remote Docker hosts only. Local-socket access is out of
 * scope per TDD-001 §10 / SPEC-001-2-02.
 */

import { MCPOrSSHConnection, type MCPOrSSHOptions } from './shared-mcp-ssh.js';

export type DockerConnectionOptions = MCPOrSSHOptions;

export class DockerConnection extends MCPOrSSHConnection {
  constructor(platformId: string, opts: DockerConnectionOptions) {
    super(platformId, opts);
  }

  protected override mcpServerName(): string {
    return 'mcp-server-docker';
  }
}
