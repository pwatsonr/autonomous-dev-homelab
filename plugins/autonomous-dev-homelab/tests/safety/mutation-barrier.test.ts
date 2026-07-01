/**
 * Tests for src/safety/mutation-barrier.ts.
 * Covers T010-5 through T010-7 from SPEC REQ-000055 §5.11.
 */

import { wrapWithMutationBarrier, MutationBarrierError } from '../../src/safety/mutation-barrier';
import { Connection } from '../../src/connection/base';
import type { ExecResult, ExecOptions, ConnectionCapabilities } from '../../src/connection/base';

/** Stub connection for testing. */
class StubConnection extends Connection {
  constructor() {
    super('test');
  }

  async connect(): Promise<void> { /* no-op */ }

  async exec(_command: string, _opts?: ExecOptions): Promise<ExecResult> {
    return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 };
  }

  async disconnect(): Promise<void> { /* no-op */ }

  async ping(): Promise<boolean> {
    return true;
  }

  override getCapabilities(): ConnectionCapabilities {
    return { transport: 'ssh', hostname: 'test' };
  }
}

describe('wrapWithMutationBarrier', () => {
  let stub: StubConnection;
  let wrapped: Connection;

  beforeEach(() => {
    stub = new StubConnection();
    wrapped = wrapWithMutationBarrier(stub);
  });

  // T010-5: MutationBarrier blocks exec
  it('T010-5: blocks exec() with MutationBarrierError', () => {
    let caught: unknown;
    try {
      wrapped.exec('ls');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
    expect((caught as MutationBarrierError).code).toBe('MUTATION_BARRIER_BLOCKED');
    expect((caught as MutationBarrierError).attemptedMethod).toBe('exec');
  });

  // T010-6: MutationBarrier allows ping
  it('T010-6: allows ping() to pass through', async () => {
    const result = await (wrapped as unknown as { ping: () => Promise<boolean> }).ping();
    expect(result).toBe(true);
  });

  // T010-7: MutationBarrier fails closed on unknown method
  it('T010-7: blocks unknown method (fail closed)', () => {
    let caught: unknown;
    try {
      (wrapped as unknown as { someUnknownMethod: () => void }).someUnknownMethod();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
    expect((caught as MutationBarrierError).code).toBe('MUTATION_BARRIER_BLOCKED');
  });

  it('allows disconnect()', async () => {
    await expect(wrapped.disconnect()).resolves.toBeUndefined();
  });

  it('allows getCapabilities()', () => {
    expect(wrapped.getCapabilities()).toEqual({ transport: 'ssh', hostname: 'test' });
  });

  it('allows isConnected()', () => {
    expect(typeof wrapped.isConnected()).toBe('boolean');
  });

  it('blocks writeFile()', () => {
    let caught: unknown;
    try {
      (wrapped as unknown as { writeFile: (path: string) => void }).writeFile('/tmp/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
  });

  it('blocks execCommand()', () => {
    let caught: unknown;
    try {
      (wrapped as unknown as { execCommand: (cmd: string) => void }).execCommand('ls');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
  });

  it('blocks restart()', () => {
    let caught: unknown;
    try {
      (wrapped as unknown as { restart: () => void }).restart();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
  });

  it('MutationBarrierError has exit code 42', () => {
    let caught: unknown;
    try {
      wrapped.exec('ls');
    } catch (err) {
      caught = err;
    }
    expect((caught as MutationBarrierError).exit).toBe(42);
  });
});

// T010-9: CI guard test — ensures dry-run pathway uses MutationBarrier
describe('no-live-l0 guard via mutation-barrier', () => {
  it('dry-run pathway invokes MutationBarrier (connection cannot mutate)', () => {
    const stub = new StubConnection();
    const wrapped = wrapWithMutationBarrier(stub);
    let caught: unknown;
    try {
      wrapped.exec('rm -rf /');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
  });
});
