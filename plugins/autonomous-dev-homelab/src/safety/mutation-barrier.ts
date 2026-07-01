/**
 * MutationBarrier: wraps a Connection so any non-read operation throws
 * synchronously. Used in dry-run flows to guarantee no live mutations.
 * SPEC: REQ-000055 §2.13, TASK-010.
 *
 * Enforcement is a `Proxy` intercepting property access; unknown methods
 * default to blocked (fail closed).
 */

import type { Connection } from '../connection/base.js';
import { MutationBarrierError } from '../secrets/errors.js';

export { MutationBarrierError };

export interface MutationBarrierBlockedError extends Error {
  readonly code: 'MUTATION_BARRIER_BLOCKED';
  readonly attemptedMethod: string;
}

/**
 * Method names allowed through the barrier (read-only operations).
 * Exact match set.
 */
const READ_OP_EXACT = new Set([
  'ping',
  'close',
  'disconnect',
  'isConnected',
  'getCapabilities',
  'getLastUsedAt',
]);

/**
 * Prefixes of method names that allow the method through.
 */
const READ_OP_PREFIXES = ['read', 'get', 'list', 'stat', 'inspect'];

/**
 * Non-method property names that should always pass through (e.g. string fields).
 */
const NON_METHOD_PROPS = new Set([
  'platformId',
  'connected',
  'capabilities',
  'lastUsedAt',
  'constructor',
  '__auditWrapped',
  // Symbol-derived identifiers
  'Symbol(Symbol.toPrimitive)',
  'Symbol(Symbol.toStringTag)',
  'then',  // allow thenable check
]);

function isReadOp(name: string): boolean {
  if (READ_OP_EXACT.has(name)) return true;
  return READ_OP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Wrap a Connection so any non-read op throws MutationBarrierError synchronously.
 * Fail closed: any method not explicitly allowed is blocked, including non-existent methods.
 */
export function wrapWithMutationBarrier(conn: Connection): Connection {
  return new Proxy(conn, {
    get(target: Connection, prop: string | symbol): unknown {
      const name = typeof prop === 'symbol' ? (Symbol.keyFor(prop) ?? String(prop)) : prop;

      // If it's a read op, allow it regardless of whether it exists
      if (isReadOp(name)) {
        const value = (target as unknown as Record<string, unknown>)[name];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }

      // Check if this is a known non-method property
      if (NON_METHOD_PROPS.has(name)) {
        return (target as unknown as Record<string, unknown>)[name];
      }

      // Get value from target
      const value = (target as unknown as Record<string, unknown>)[name];

      // Non-existent property (undefined/null): fail closed — could be a method call
      // Return a blocking function so that unknownMethod() throws MutationBarrierError
      if (value === undefined || value === null) {
        return (): never => {
          throw new MutationBarrierError(name);
        };
      }

      // Existing function: block it
      if (typeof value === 'function') {
        return (): never => {
          throw new MutationBarrierError(name);
        };
      }

      // Non-function existing property: pass through (e.g., connection metadata)
      return value;
    },
  }) as Connection;
}
