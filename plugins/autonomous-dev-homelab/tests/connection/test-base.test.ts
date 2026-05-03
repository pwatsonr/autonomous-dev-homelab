/**
 * Compile + abstract-surface tests for the `Connection` base class.
 * Covers SPEC-001-2-01 acceptance criteria for `src/connection/base.ts`.
 */

import { Connection } from '../../src/connection/base';
import type { ConnectionCapabilities, ExecResult } from '../../src/connection/base';

class TestConnection extends Connection {
  public connectCalls = 0;
  public execCalls: string[] = [];
  public disconnectCalls = 0;

  override async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
    this.lastUsedAt = 12345;
    this.capabilities = { transport: 'ssh', hostname: 'h', user: 'root' };
  }

  override async exec(command: string): Promise<ExecResult> {
    this.execCalls.push(command);
    return { stdout: command, stderr: '', exitCode: 0, durationMs: 1 };
  }

  override async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

describe('Connection (base)', () => {
  test('exposes platformId via constructor and isConnected default false', () => {
    const c = new TestConnection('proxmox-01');
    expect(c.platformId).toBe('proxmox-01');
    expect(c.isConnected()).toBe(false);
    expect(c.getCapabilities()).toBeUndefined();
    expect(c.getLastUsedAt()).toBe(0);
  });

  test('subclass can populate capabilities and connection state', async () => {
    const c = new TestConnection('docker-01');
    await c.connect();
    expect(c.isConnected()).toBe(true);
    expect(c.getLastUsedAt()).toBe(12345);
    const caps = c.getCapabilities() as ConnectionCapabilities;
    expect(caps.transport).toBe('ssh');
    expect(caps.hostname).toBe('h');
    await c.disconnect();
    expect(c.isConnected()).toBe(false);
  });

  test('exec receives commands verbatim', async () => {
    const c = new TestConnection('p1');
    const r = await c.exec('whoami');
    expect(r.stdout).toBe('whoami');
    expect(r.exitCode).toBe(0);
  });
});
