/**
 * Shared MCP-first / SSH-fallback machinery for Linux-style platform
 * connections (Proxmox, Docker, K8s, TrueNAS-when-falling-back-to-SSH,
 * Unraid). Implements the common pattern from SPEC-001-2-02
 * §"Common Subclass Pattern".
 *
 * Subclasses provide:
 * - their MCP server name (e.g. 'mcp-server-proxmox'),
 * - the credentials needed for SSH cert auth,
 * - optional injected MCPClient / SSHClient instances for tests.
 *
 * This file is import-only by subclasses; it is not a public API.
 */

import { Connection } from './base.js';
import type { ConnectionCapabilities, ExecOptions, ExecResult } from './base.js';
import {
  ConnectionTimeoutError,
  MCPUnavailableError,
  SSHAuthError,
  type MCPUnavailableReason,
} from './errors.js';
import { NullMCPClient, withMCPTimeout, type MCPClient } from './mcp-client.js';
import { SSHClient, type SSHCertCredentials } from './ssh-client.js';

export interface MCPOrSSHOptions {
  hostname: string;
  sshUser?: string;
  sshPort?: number;
  privateKeyPath: string;
  certPath: string;
  /** When set, force the chosen transport. Default: try MCP, fall back to SSH. */
  preferTransport?: 'mcp' | 'ssh';
  /** Custom MCP timeout in ms. Default 5000. */
  mcpTimeoutMs?: number;
  mcpClient?: MCPClient;
  sshClient?: SSHClient;
  logger?: ConnectionLogger;
}

export interface ConnectionLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  warn?(msg: string, ctx?: Record<string, unknown>): void;
}

const NULL_LOGGER: ConnectionLogger = {
  debug: (): void => {
    /* noop */
  },
};

const DEFAULT_MCP_TIMEOUT = 5000;
const DEFAULT_EXEC_TIMEOUT = 60_000;

export abstract class MCPOrSSHConnection extends Connection {
  protected readonly opts: MCPOrSSHOptions;
  protected readonly logger: ConnectionLogger;
  protected readonly mcpClient: MCPClient;
  protected readonly sshClient: SSHClient;

  /** Subclasses override to provide their MCP server name. */
  protected abstract mcpServerName(): string;

  /**
   * Subclasses override only if they need a non-default MCP exec mapping.
   * Default sends `{toolName: 'shell_exec', args: {command}}`.
   */
  protected mcpExecCall(command: string): { tool: string; args: Record<string, unknown> } {
    return { tool: 'shell_exec', args: { command } };
  }

  constructor(platformId: string, opts: MCPOrSSHOptions) {
    super(platformId);
    this.opts = opts;
    this.logger = opts.logger ?? NULL_LOGGER;
    this.mcpClient = opts.mcpClient ?? new NullMCPClient();
    this.sshClient = opts.sshClient ?? new SSHClient();
  }

  override async connect(): Promise<void> {
    this.lastUsedAt = Date.now();
    const prefer = this.opts.preferTransport;
    let mcpError: MCPUnavailableError | undefined;
    if (prefer !== 'ssh') {
      try {
        await this.tryMCP();
        return;
      } catch (err) {
        mcpError = normalizeMcpError(err);
        this.logger.debug('mcp_unavailable_falling_back_to_ssh', {
          platformId: this.platformId,
          reason: mcpError.reason,
          message: mcpError.message,
        });
        if (prefer === 'mcp') {
          // Operator forced MCP-only; surface the failure.
          throw mcpError;
        }
      }
    }
    try {
      await this.fallbackSSH();
    } catch (err) {
      if (err instanceof SSHAuthError && mcpError !== undefined) {
        // Preserve the MCP error for diagnostic CLI access.
        err.mcpError = mcpError;
      }
      throw err;
    }
  }

  protected async tryMCP(): Promise<void> {
    const timeoutMs = this.opts.mcpTimeoutMs ?? DEFAULT_MCP_TIMEOUT;
    await withMCPTimeout(
      this.mcpClient.connect(this.mcpServerName(), { host: this.opts.hostname }, timeoutMs),
      timeoutMs,
    );
    this.connected = true;
    this.capabilities = {
      transport: 'mcp',
      serverName: this.mcpServerName(),
      hostname: this.opts.hostname,
      ...(this.opts.sshUser !== undefined ? { user: this.opts.sshUser } : {}),
    };
  }

  protected async fallbackSSH(): Promise<void> {
    const creds: SSHCertCredentials = {
      host: this.opts.hostname,
      ...(this.opts.sshPort !== undefined ? { port: this.opts.sshPort } : {}),
      username: this.opts.sshUser ?? 'root',
      privateKeyPath: this.opts.privateKeyPath,
      certPath: this.opts.certPath,
    };
    await this.sshClient.connect(creds);
    this.connected = true;
    this.capabilities = {
      transport: 'ssh',
      hostname: this.opts.hostname,
      user: creds.username,
      certFingerprint: await readCertFingerprint(this.opts.certPath),
    };
  }

  override async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.connected || this.capabilities === undefined) {
      throw new SSHAuthError('exec called before connect()');
    }
    this.lastUsedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT;
    const start = Date.now();
    if (this.capabilities.transport === 'mcp') {
      const { tool, args } = this.mcpExecCall(command);
      let result;
      try {
        result = await Promise.race([
          this.mcpClient.call(tool, args, timeoutMs),
          mcpExecTimeout(timeoutMs),
        ]);
      } catch (err) {
        if (err instanceof ConnectionTimeoutError) throw err;
        throw err;
      }
      return normalizeMcpExecResult(result, Date.now() - start);
    }
    return this.sshClient.execCommand(command, { timeoutMs });
  }

  override async disconnect(): Promise<void> {
    // Idempotent; tolerate per-transport errors.
    if (this.capabilities?.transport === 'mcp') {
      try {
        await this.mcpClient.disconnect();
      } catch {
        // best-effort
      }
    }
    if (this.capabilities?.transport === 'ssh') {
      try {
        await this.sshClient.disconnect();
      } catch {
        // best-effort
      }
    }
    this.connected = false;
  }
}

function normalizeMcpError(err: unknown): MCPUnavailableError {
  if (err instanceof MCPUnavailableError) return err;
  const reason: MCPUnavailableReason = 'other';
  return new MCPUnavailableError(reason, (err as Error).message ?? String(err), err as Error);
}

async function mcpExecTimeout(timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new ConnectionTimeoutError('mcp', timeoutMs)), timeoutMs).unref?.();
  });
}

function normalizeMcpExecResult(r: { content: unknown; isError: boolean }, durationMs: number): ExecResult {
  // The MCP server is expected to return `{stdout, stderr, exitCode}` either
  // directly or under `content`. Tolerate both shapes.
  const c = (r.content as Record<string, unknown> | undefined) ?? {};
  const stdout = typeof c.stdout === 'string' ? c.stdout : '';
  const stderr = typeof c.stderr === 'string' ? c.stderr : '';
  const exitCode = typeof c.exitCode === 'number' ? c.exitCode : r.isError ? 1 : 0;
  return { stdout, stderr, exitCode, durationMs };
}

async function readCertFingerprint(certPath: string): Promise<string | undefined> {
  // We don't shell out to ssh-keygen here to keep the SSH path zero-deps
  // at runtime. The CertificateMetadata returned by SSHCertificateManager
  // is the source of truth for fingerprints; this helper just reads the
  // raw cert bytes and surfaces a stable identifier that callers can
  // grep for. Returns undefined on any error (best-effort).
  try {
    const fs = await import('node:fs/promises');
    const crypto = await import('node:crypto');
    const buf = await fs.readFile(certPath);
    const hash = crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
  } catch {
    return undefined;
  }
}
