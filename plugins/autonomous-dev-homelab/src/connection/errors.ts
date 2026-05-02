/**
 * Error types thrown by the connection layer. Implements
 * SPEC-001-2-02 §"`src/connection/errors.ts`".
 *
 * Each class extends `Error`, sets `name` correctly, and exposes any
 * useful structured fields (reason, transport) so consumers can branch
 * on them without parsing message strings.
 */

export type MCPUnavailableReason =
  | 'not_installed'
  | 'connection_refused'
  | 'auth_failed'
  | 'timeout'
  | 'other';

export class MCPUnavailableError extends Error {
  public readonly reason: MCPUnavailableReason;
  public readonly cause?: Error;

  constructor(reason: MCPUnavailableReason, message?: string, cause?: Error) {
    super(message ?? `MCP unavailable: ${reason}`);
    this.name = 'MCPUnavailableError';
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

export class SSHAuthError extends Error {
  public readonly cause?: Error;
  /** When attached by `Connection.connect()`, captures the prior MCP failure. */
  public mcpError?: MCPUnavailableError;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'SSHAuthError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConnectionTimeoutError extends Error {
  public readonly transport: 'mcp' | 'ssh';
  public readonly timeoutMs: number;

  constructor(transport: 'mcp' | 'ssh', timeoutMs: number, message?: string) {
    super(message ?? `${transport} timed out after ${timeoutMs}ms`);
    this.name = 'ConnectionTimeoutError';
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }
}

export class UnsupportedExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedExecError';
  }
}
