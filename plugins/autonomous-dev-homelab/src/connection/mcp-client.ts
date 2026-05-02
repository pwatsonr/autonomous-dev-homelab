/**
 * MCPClient interface: thin contract that platform connections call into
 * for MCP-first transport. Implements SPEC-001-2-02
 * §"`src/connection/mcp-client.ts`".
 *
 * The default implementation is a NullMCPClient that always rejects
 * with `MCPUnavailableError('not_installed')`. This keeps the daemon
 * working out-of-the-box (SSH-fallback path is exercised) until an
 * operator wires in a real MCP discovery layer (PLAN-001-3).
 *
 * Subclasses accept an `MCPClient` via constructor injection so tests
 * (and the future MCP discovery layer) can swap the implementation.
 */

import { MCPUnavailableError } from './errors.js';

export interface MCPCallResult {
  /** Tool result payload — shape depends on the upstream tool. */
  content: unknown;
  isError: boolean;
}

export interface MCPClient {
  connect(serverName: string, params: Record<string, unknown>, timeoutMs?: number): Promise<void>;
  call(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPCallResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

/** Default MCPClient that reports the server is not installed. */
export class NullMCPClient implements MCPClient {
  async connect(_serverName: string): Promise<void> {
    throw new MCPUnavailableError(
      'not_installed',
      'no MCPClient implementation wired in (NullMCPClient default)',
    );
  }

  async call(): Promise<MCPCallResult> {
    throw new MCPUnavailableError('not_installed');
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  isConnected(): boolean {
    return false;
  }
}

/**
 * Wraps a `connect()` Promise with an MCP-specific timeout. On timeout,
 * the wrapper throws `MCPUnavailableError('timeout')` so the calling
 * subclass treats it as a normal MCP-unavailable signal rather than a
 * generic ConnectionTimeoutError.
 */
export async function withMCPTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MCPUnavailableError('timeout', `MCP timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
