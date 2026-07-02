/**
 * CI guard: ensures the dry-run pathway enforces MutationBarrier.
 * SPEC: REQ-000055 T010-9.
 *
 * This test verifies that the MutationBarrier is actually enforced when
 * a dry-run is requested. If the barrier is removed, this test fails.
 */

import { wrapWithMutationBarrier, MutationBarrierError } from '../../src/safety/mutation-barrier';
import { Connection } from '../../src/connection/base';
import type { ExecResult, ExecOptions, ConnectionCapabilities } from '../../src/connection/base';

/** Test double for a mutable connection. */
class MutableStubConnection extends Connection {
  execCalled = false;

  constructor() {
    super('no-live-test');
  }

  async connect(): Promise<void> { /* no-op */ }

  async exec(_cmd: string, _opts?: ExecOptions): Promise<ExecResult> {
    this.execCalled = true;
    return { stdout: 'executed!', stderr: '', exitCode: 0, durationMs: 1 };
  }

  async disconnect(): Promise<void> { /* no-op */ }

  override getCapabilities(): ConnectionCapabilities {
    return { transport: 'ssh', hostname: 'no-live-test' };
  }
}

describe('no-live-l0: dry-run pathway enforces MutationBarrier', () => {
  it('MutationBarrier prevents exec() calls in dry-run pathway', () => {
    const conn = new MutableStubConnection();
    const wrapped = wrapWithMutationBarrier(conn);

    let caught: unknown;
    try {
      wrapped.exec('docker service restart portainer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);

    // Verify the underlying connection was NOT actually called
    expect(conn.execCalled).toBe(false);
  });

  it('MutationBarrier allows read operations in dry-run pathway', () => {
    const conn = new MutableStubConnection();
    const wrapped = wrapWithMutationBarrier(conn);

    // Read ops must not throw
    expect(() => wrapped.getCapabilities()).not.toThrow();
    expect(() => wrapped.isConnected()).not.toThrow();
  });

  it('barrier fails closed: any unknown method is blocked', () => {
    const conn = new MutableStubConnection();
    const wrapped = wrapWithMutationBarrier(conn);

    // Unknown method should be blocked (fail closed)
    let caught: unknown;
    try {
      (wrapped as unknown as { dangerousOp: () => void }).dangerousOp();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MutationBarrierError);
  });
});
