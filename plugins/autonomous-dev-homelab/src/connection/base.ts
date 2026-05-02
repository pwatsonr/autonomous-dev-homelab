/**
 * Abstract `Connection` contract for the homelab plugin. Implements
 * SPEC-001-2-01 §"`src/connection/base.ts`" / TDD-001 §8.
 *
 * Every platform subclass (Proxmox, Docker, K8s, UniFi, TrueNAS, Unraid)
 * extends this base. The base intentionally does not enforce a connection
 * lifecycle state machine — subclasses self-police via the `connected`
 * flag because their lifecycles diverge (e.g. UniFi has no persistent
 * socket).
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ConnectionCapabilities {
  transport: 'mcp' | 'ssh' | 'https';
  /** e.g. 'mcp-server-proxmox' when transport === 'mcp'. */
  serverName?: string;
  hostname: string;
  user?: string;
  /** Ed25519 fingerprint when ssh+cert; undefined for https/mcp. */
  certFingerprint?: string;
}

export interface ExecOptions {
  /** Per-call timeout. Subclasses default to 60_000ms when undefined. */
  timeoutMs?: number;
}

export abstract class Connection {
  protected connected = false;
  protected capabilities?: ConnectionCapabilities;
  protected lastUsedAt = 0;

  constructor(public readonly platformId: string) {}

  abstract connect(): Promise<void>;
  abstract exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  abstract disconnect(): Promise<void>;

  getCapabilities(): ConnectionCapabilities | undefined {
    return this.capabilities;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastUsedAt(): number {
    return this.lastUsedAt;
  }
}
