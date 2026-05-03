/**
 * Shared mock connection factories for the homelab deploy backend tests.
 * SPEC-002-3-04 §"`mock-connections.ts`".
 *
 * Each factory returns a Connection-shaped object whose `exec` is driven
 * by a `Map<string, ExecResult>` (keyed by exact command string OR by a
 * substring match) plus a `recordedCalls` list for ordering assertions.
 */

import type { Connection, ExecResult } from '../../src/connection/base.js';

export interface MockExecMap {
  /** Exact-match command → result. */
  exact?: Map<string, { stdout: string; stderr: string; exitCode: number }>;
  /** Pattern (substring) → result. First match wins. */
  patterns?: Array<{
    match: string;
    result: { stdout: string; stderr: string; exitCode: number };
  }>;
  /** Default result when no match. */
  fallback?: { stdout: string; stderr: string; exitCode: number };
}

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export interface MockConnection extends Connection {
  recordedCalls: RecordedCall[];
}

function makeConnection(platformId: string, execMap: MockExecMap): MockConnection {
  const recorded: RecordedCall[] = [];
  const conn = {
    platformId,
    recordedCalls: recorded,
    isConnected(): boolean {
      return true;
    },
    getCapabilities(): undefined {
      return undefined;
    },
    getLastUsedAt(): number {
      return Date.now();
    },
    async connect(): Promise<void> {
      recorded.push({ op: 'connect', args: [] });
    },
    async disconnect(): Promise<void> {
      recorded.push({ op: 'disconnect', args: [] });
    },
    async exec(command: string): Promise<ExecResult> {
      recorded.push({ op: 'exec', args: [command] });
      const exact = execMap.exact?.get(command);
      if (exact !== undefined) return { ...exact, durationMs: 1 };
      for (const p of execMap.patterns ?? []) {
        if (command.includes(p.match)) return { ...p.result, durationMs: 1 };
      }
      const fallback = execMap.fallback ?? { stdout: '', stderr: '', exitCode: 0 };
      return { ...fallback, durationMs: 1 };
    },
  } as unknown as MockConnection;
  return conn;
}

export function mockProxmoxConnection(execMap: MockExecMap = {}): MockConnection {
  return makeConnection('mock-proxmox', execMap);
}

export function mockDockerSwarmConnection(execMap: MockExecMap = {}): MockConnection {
  return makeConnection('mock-swarm', execMap);
}
