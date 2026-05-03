/**
 * Typed-CONFIRM modal. SPEC-002-2-02.
 *
 * Resolves true ONLY if the operator types the literal expected word
 * (default 'CONFIRM', case-sensitive, no trim) within `ttl_seconds`.
 * Any other input — lowercase variants, whitespace-padded, EOF, timeout
 * — resolves false.
 *
 * Strict equality is intentional friction: trimming or case-folding
 * would let `' confirm\n'` succeed.
 */

import { promptLine } from './io-stdin.js';
import { emitBypassAttempt } from '../metrics/emitters.js';

export interface TypedConfirmInput {
  message: string;
  /** Wall-clock timeout in seconds. */
  ttl_seconds: number;
  /** Default 'CONFIRM'. Override for tests only. */
  expectedWord?: string;
  /**
   * Operator id used for `homelab_bypass_attempts_total` metric labels
   * when a non-CONFIRM input is received. Default `'unknown'`. SPEC-002-3-03.
   */
  operatorId?: string;
}

/**
 * Prompts the operator and resolves boolean. Never throws — operator
 * input failure or timeout resolves to false.
 */
export async function typedConfirmModal(input: TypedConfirmInput): Promise<boolean> {
  const expected = input.expectedWord ?? 'CONFIRM';
  const ttlMs = input.ttl_seconds * 1000;

  const prompt =
    `\n${input.message}\n` +
    `Type ${expected} (case-sensitive) within ${input.ttl_seconds}s to proceed: `;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(false), ttlMs);
    // Don't keep the event loop alive solely for the prompt's TTL.
    if (typeof timer.unref === 'function') timer.unref();

    promptLine(prompt)
      .then((answer) => {
        const matched = answer === expected;
        if (!matched) {
          // SPEC-002-3-03: any input other than the literal expected word
          // counts as a bypass attempt for the safety metric.
          emitBypassAttempt(input.operatorId ?? 'unknown', 'wrong-confirm');
        }
        settle(matched);
      })
      .catch(() => settle(false));
  });
}
