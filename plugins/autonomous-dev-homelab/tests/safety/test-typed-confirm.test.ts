/**
 * Typed-CONFIRM modal tests per SPEC-002-2-02 acceptance criteria.
 *
 * Strategy: inject a fake `promptLine` via `__setPromptLine` so we never
 * touch real stdin. Timeout cases use Jest fake timers.
 */

import { typedConfirmModal } from '../../src/safety/typed-confirm';
import { __setPromptLine } from '../../src/safety/io-stdin';

afterEach(() => {
  __setPromptLine(undefined);
  jest.useRealTimers();
});

describe('typedConfirmModal', () => {
  it('resolves true when operator types the literal "CONFIRM"', async () => {
    __setPromptLine(async () => 'CONFIRM');
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(true);
  });

  it('resolves false for lowercase "confirm" (case-sensitive)', async () => {
    __setPromptLine(async () => 'confirm');
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(false);
  });

  it('resolves false for whitespace-padded " CONFIRM " (no trim)', async () => {
    __setPromptLine(async () => ' CONFIRM ');
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(false);
  });

  it('resolves false for "yes"', async () => {
    __setPromptLine(async () => 'yes');
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(false);
  });

  it('resolves false on EOF (empty string)', async () => {
    __setPromptLine(async () => '');
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(false);
  });

  it('resolves false when prompt rejects (operator interrupts)', async () => {
    __setPromptLine(async () => Promise.reject(new Error('SIGINT')));
    const ok = await typedConfirmModal({ message: 'do it?', ttl_seconds: 5 });
    expect(ok).toBe(false);
  });

  it('respects custom expectedWord override', async () => {
    __setPromptLine(async () => 'DELETE');
    const ok = await typedConfirmModal({
      message: 'really?',
      ttl_seconds: 5,
      expectedWord: 'DELETE',
    });
    expect(ok).toBe(true);
  });

  it('still rejects "delete" when expectedWord is "DELETE"', async () => {
    __setPromptLine(async () => 'delete');
    const ok = await typedConfirmModal({
      message: 'really?',
      ttl_seconds: 5,
      expectedWord: 'DELETE',
    });
    expect(ok).toBe(false);
  });

  it('resolves false when the TTL elapses before input arrives', async () => {
    jest.useFakeTimers();
    let resolveLate: ((s: string) => void) | undefined;
    __setPromptLine(
      () =>
        new Promise<string>((res) => {
          resolveLate = res;
        }),
    );
    const promise = typedConfirmModal({ message: 'do it?', ttl_seconds: 1 });
    jest.advanceTimersByTime(1500);
    const ok = await promise;
    expect(ok).toBe(false);
    // Late input must NOT flip the result back to true.
    if (resolveLate !== undefined) resolveLate('CONFIRM');
  });
});
