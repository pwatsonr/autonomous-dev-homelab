/**
 * Stdin abstraction for the typed-CONFIRM modal. SPEC-002-2-02.
 *
 * Production: wraps `node:readline/promises` against `process.stdin`.
 * Tests: inject a mock prompter via `__setPromptLine`. The leading
 * double-underscore marks the export as test-only by convention; do not
 * call from production code.
 */

import * as readline from 'node:readline/promises';

type PromptFn = (prompt: string) => Promise<string>;

let injected: PromptFn | undefined;

/** Test-only: inject a fake prompter; pass `undefined` to clear. */
export function __setPromptLine(fn: PromptFn | undefined): void {
  injected = fn;
}

/** Reads a single line from stdin. Resolves with the raw input (no trim). */
export async function promptLine(prompt: string): Promise<string> {
  if (injected !== undefined) return injected(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
