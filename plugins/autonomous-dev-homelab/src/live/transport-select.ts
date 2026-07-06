/**
 * Transport selection: MCP-first with SSH fallback.
 * SPEC: REQ-000055 §2.8.
 *
 * Given a host config, probes the MCP endpoint (if configured) and returns
 * the preferred transport. Falls back to SSH when MCP is unavailable.
 */

import type { Host } from '../config/types.js';

export interface TransportChoice {
  transport: 'mcp' | 'ssh';
  endpoint: string;
  reason: 'mcp-live' | 'mcp-unreachable' | 'mcp-not-configured';
}

export interface MCPProbeCapable {
  probe(endpoint: string, opts: { timeoutMs: number }): Promise<boolean>;
}

/**
 * Pick transport for a host.
 *
 * 1. If `host.mcp_endpoint` is undefined → SSH (mcp-not-configured).
 * 2. Else probe the MCP endpoint with a timeout.
 *    - true within timeout → MCP (mcp-live).
 *    - timeout / false / error → SSH (mcp-unreachable).
 */
export async function pickTransport(
  host: Host,
  mcp: MCPProbeCapable,
  opts?: { timeoutMs?: number },
): Promise<TransportChoice> {
  if (host.mcp_endpoint === undefined) {
    return {
      transport: 'ssh',
      endpoint: host.ssh_fallback.host,
      reason: 'mcp-not-configured',
    };
  }

  const timeoutMs = opts?.timeoutMs ?? 2000;
  const endpoint = host.mcp_endpoint;

  try {
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      // .unref() prevents this timer from keeping the Jest worker alive.
      const t = setTimeout(() => reject(new Error('MCP probe timeout')), timeoutMs);
      if (typeof t === 'object' && t !== null && typeof (t as NodeJS.Timeout).unref === 'function') {
        (t as NodeJS.Timeout).unref();
      }
    });
    const probePromise = mcp.probe(endpoint, { timeoutMs });
    const result = await Promise.race([probePromise, timeoutPromise]);

    if (result === true) {
      return { transport: 'mcp', endpoint, reason: 'mcp-live' };
    }
    return { transport: 'ssh', endpoint: host.ssh_fallback.host, reason: 'mcp-unreachable' };
  } catch {
    return { transport: 'ssh', endpoint: host.ssh_fallback.host, reason: 'mcp-unreachable' };
  }
}
