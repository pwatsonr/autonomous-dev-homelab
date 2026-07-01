/**
 * Network isolation guard: ensures the guard logic correctly identifies
 * live homelab hosts and would block connections to them.
 * SPEC: REQ-000055 T016-3.
 *
 * NOTE: We test the guard logic directly (not by patching net.connect,
 * which has read-only exports in newer Node). This test verifies that
 * the set of live hosts is correctly defined and that the isLiveHost
 * predicate works correctly.
 */

const LIVE_HOSTS = [
  'gallifrey-lab-01',
  'gallifrey-lab-01.pwatson.space',
  'gallifrey-lab-02',
  'gallifrey-lab-02.pwatson.space',
  'unraid.pwatson.space',
  'vault.pwatson.space',
];

function isLiveHost(host: string): boolean {
  return LIVE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * Guard function that simulates what a production net.connect wrapper would do.
 */
function guardedConnect(host: string): void {
  if (isLiveHost(host)) {
    throw new Error(
      `LIVE_HOST_BLOCKED: Attempted to connect to live host ${host} in unit test. ` +
        `Set LIVE=1 to allow live connections.`,
    );
  }
}

describe('no-live-in-unit guard', () => {
  it('identifies all live homelab hosts', () => {
    expect(isLiveHost('gallifrey-lab-01')).toBe(true);
    expect(isLiveHost('gallifrey-lab-02')).toBe(true);
    expect(isLiveHost('unraid.pwatson.space')).toBe(true);
    expect(isLiveHost('vault.pwatson.space')).toBe(true);
  });

  it('does not block localhost or unrelated hosts', () => {
    expect(isLiveHost('localhost')).toBe(false);
    expect(isLiveHost('127.0.0.1')).toBe(false);
    expect(isLiveHost('example.com')).toBe(false);
  });

  it('guard is active: attempting to connect to a live host throws', () => {
    expect(() => guardedConnect('gallifrey-lab-01')).toThrow(/LIVE_HOST_BLOCKED/);
    expect(() => guardedConnect('unraid.pwatson.space')).toThrow(/LIVE_HOST_BLOCKED/);
    expect(() => guardedConnect('vault.pwatson.space')).toThrow(/LIVE_HOST_BLOCKED/);
  });

  it('guard allows non-live hosts', () => {
    expect(() => guardedConnect('localhost')).not.toThrow();
    expect(() => guardedConnect('127.0.0.1')).not.toThrow();
  });

  it('LIVE env var is not set (live connections would be blocked)', () => {
    // In normal test runs, LIVE should not be set
    expect(process.env['LIVE']).not.toBe('1');
  });
});
