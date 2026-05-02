/**
 * `K8sConnection`: MCP-first via `mcp-server-kubernetes`, SSH `kubectl`
 * fallback. Implements SPEC-001-2-02 §"`src/connection/k8s.ts`".
 *
 * The SSH transport assumes the SSH user has `kubectl` on PATH and a
 * kubeconfig at the default location; capability detection does not
 * preflight this — surfaces naturally on the first real exec.
 */

import { MCPOrSSHConnection, type MCPOrSSHOptions } from './shared-mcp-ssh.js';

export type K8sConnectionOptions = MCPOrSSHOptions;

export class K8sConnection extends MCPOrSSHConnection {
  constructor(platformId: string, opts: K8sConnectionOptions) {
    super(platformId, opts);
  }

  protected override mcpServerName(): string {
    return 'mcp-server-kubernetes';
  }
}
