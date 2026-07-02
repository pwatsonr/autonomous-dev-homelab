/**
 * Tests for src/live/transport-select.ts.
 * Covers T006-1 through T006-4 from SPEC REQ-000055 §5.7.
 */

import { pickTransport, type MCPProbeCapable } from '../../src/live/transport-select';
import type { Host } from '../../src/config/types';

const HOST_WITH_MCP: Host = {
  hostname: 'gallifrey-lab-01',
  platform: 'docker-swarm-manager',
  role: 'manager',
  mcp_endpoint: 'https://mcp.gallifrey-lab-01.pwatson.space',
  ssh_fallback: {
    host: 'gallifrey-lab-01',
    port: 22,
    user: 'patrick',
    key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key1' },
  },
};

const HOST_WITHOUT_MCP: Host = {
  hostname: 'gallifrey-lab-02',
  platform: 'docker-swarm-worker',
  role: 'worker',
  ssh_fallback: {
    host: 'gallifrey-lab-02',
    port: 22,
    user: 'patrick',
    key_ref: { vault_path: 'kv/data/homelab/ssh', vault_field: 'key2' },
  },
};

describe('pickTransport', () => {
  // T006-1: MCP live
  it('T006-1: returns mcp transport when probe returns true', async () => {
    const mcp: MCPProbeCapable = { probe: jest.fn(async () => true) };
    const result = await pickTransport(HOST_WITH_MCP, mcp);
    expect(result.transport).toBe('mcp');
    expect(result.reason).toBe('mcp-live');
    expect(result.endpoint).toBe('https://mcp.gallifrey-lab-01.pwatson.space');
  });

  // T006-2: MCP unreachable (timeout)
  it('T006-2: returns ssh transport when MCP probe times out', async () => {
    const mcp: MCPProbeCapable = {
      probe: jest.fn(async () => new Promise<boolean>(() => { /* never resolves */ })),
    };
    const result = await pickTransport(HOST_WITH_MCP, mcp, { timeoutMs: 50 });
    expect(result.transport).toBe('ssh');
    expect(result.reason).toBe('mcp-unreachable');
    expect(result.endpoint).toBe('gallifrey-lab-01');
  }, 500);

  // T006-3: MCP not configured
  it('T006-3: returns ssh transport when host has no mcp_endpoint', async () => {
    const probeSpy = jest.fn();
    const mcp: MCPProbeCapable = { probe: probeSpy };
    const result = await pickTransport(HOST_WITHOUT_MCP, mcp);
    expect(result.transport).toBe('ssh');
    expect(result.reason).toBe('mcp-not-configured');
    expect(result.endpoint).toBe('gallifrey-lab-02');
    expect(probeSpy).not.toHaveBeenCalled();
  });

  // T006-4: MCP probe throws → ssh fallback
  it('T006-4: returns ssh transport when MCP probe throws', async () => {
    const mcp: MCPProbeCapable = {
      probe: jest.fn(async () => { throw new Error('connection refused'); }),
    };
    const result = await pickTransport(HOST_WITH_MCP, mcp);
    expect(result.transport).toBe('ssh');
    expect(result.reason).toBe('mcp-unreachable');
  });
});
