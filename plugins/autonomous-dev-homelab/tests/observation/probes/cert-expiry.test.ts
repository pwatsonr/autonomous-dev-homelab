/**
 * SPEC-002-1-03 — CertExpiryProbe unit tests.
 */

import {
  CertExpiryProbe,
  type CertFetcher,
  type CertInfo,
} from '../../../src/observation/probes/cert-expiry';

const PLATFORM = 'edge-01';
const NOW_ISO = '2026-05-02T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function inDays(days: number): string {
  return new Date(NOW_MS + days * 86_400_000).toISOString();
}

function fetcher(map: Record<string, CertInfo | Error>): CertFetcher {
  return {
    fetch: jest.fn(async (host: string, port: number) => {
      const key = `${host}:${port}`;
      const v = map[key];
      if (v === undefined) throw new Error(`no fixture for ${key}`);
      if (v instanceof Error) throw v;
      return v;
    }),
  };
}

describe('CertExpiryProbe', () => {
  const baseOpts = { platformId: PLATFORM, now: () => NOW_MS };

  test('exposes id, cadence, platformId', () => {
    const probe = new CertExpiryProbe({
      ...baseOpts,
      endpoints: [],
      fetcher: fetcher({}),
    });
    expect(probe.id).toBe('cert-expiry');
    expect(probe.cadence).toBe('slow');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('30-day cert → []', async () => {
    const probe = new CertExpiryProbe({
      ...baseOpts,
      endpoints: [{ host: 'example.local', port: 443 }],
      fetcher: fetcher({
        'example.local:443': { valid_to: inDays(30), issuer: 'CN=Test CA' },
      }),
    });
    expect(await probe.scan()).toEqual([]);
  });

  test('6-day cert → 1 observation, severity P2, days_until=6', async () => {
    const probe = new CertExpiryProbe({
      ...baseOpts,
      endpoints: [{ host: 'soon.local', port: 443 }],
      fetcher: fetcher({
        'soon.local:443': { valid_to: inDays(6), issuer: 'CN=Test CA' },
      }),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('cert_expiry_imminent');
    expect(out[0]!.severity).toBe('P2');
    expect(out[0]!.resource).toBe('cert/soon.local:443');
    expect((out[0]!.details as { days_until: number }).days_until).toBe(6);
    expect((out[0]!.details as { issuer: string }).issuer).toBe('CN=Test CA');
  });

  test('expired cert → 1 observation, days_until <= 0', async () => {
    const probe = new CertExpiryProbe({
      ...baseOpts,
      endpoints: [{ host: 'expired.local', port: 443 }],
      fetcher: fetcher({
        'expired.local:443': { valid_to: inDays(-3), issuer: 'CN=Test CA' },
      }),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect((out[0]!.details as { days_until: number }).days_until).toBeLessThanOrEqual(0);
  });

  test('fetcher error per-endpoint → unreachable sentinel for that endpoint', async () => {
    const probe = new CertExpiryProbe({
      ...baseOpts,
      endpoints: [
        { host: 'good.local', port: 443 },
        { host: 'bad.local', port: 443 },
      ],
      fetcher: fetcher({
        'good.local:443': { valid_to: inDays(60), issuer: 'CN=Test CA' },
        'bad.local:443': new Error('CONN_REFUSED'),
      }),
    });
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.resource).toBe('cert/bad.local:443');
  });
});
