/**
 * OS-aware fingerprint helper tests. Consumes SPEC-001-1-01 fingerprint
 * acceptance criteria. Tests do NOT shell out: child_process.exec and
 * fs.readFile are mocked via the FingerprintRuntime injection point.
 */

import {
  computeFingerprint,
  getDefaultGateway,
  getDnsServers,
  NoDefaultGatewayError,
  OVERRIDE_ENV,
} from '../../src/consent/fingerprint';
import type { FingerprintRuntime } from '../../src/consent/fingerprint';

function rt(overrides: Partial<FingerprintRuntime> = {}): FingerprintRuntime {
  return {
    execFile: async () => ({ stdout: '', stderr: '' }),
    readFile: async () => '',
    platform: () => 'linux',
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

describe('getDefaultGateway', () => {
  test('linux: parses `default via 192.168.1.1 dev eth0 ...`', async () => {
    const gw = await getDefaultGateway(
      rt({
        platform: () => 'linux',
        execFile: async (cmd, args) => {
          expect(cmd).toBe('ip');
          expect(args).toEqual(['-4', 'route', 'show', 'default']);
          return {
            stdout: 'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.50 metric 100\n',
            stderr: '',
          };
        },
      }),
    );
    expect(gw).toBe('192.168.1.1');
  });

  test('linux: throws when default route not present', async () => {
    await expect(
      getDefaultGateway(
        rt({
          platform: () => 'linux',
          execFile: async () => ({ stdout: '\n', stderr: '' }),
        }),
      ),
    ).rejects.toThrow(NoDefaultGatewayError);
  });

  test('darwin: parses `gateway: 192.168.1.1`', async () => {
    const gw = await getDefaultGateway(
      rt({
        platform: () => 'darwin',
        execFile: async (cmd, args) => {
          expect(cmd).toBe('route');
          expect(args).toEqual(['-n', 'get', 'default']);
          return {
            stdout: '   route to: default\n   gateway: 192.168.1.1\n   interface: en0\n',
            stderr: '',
          };
        },
      }),
    );
    expect(gw).toBe('192.168.1.1');
  });

  test('darwin: throws when no gateway line', async () => {
    await expect(
      getDefaultGateway(
        rt({
          platform: () => 'darwin',
          execFile: async () => ({ stdout: '   route to: default\n', stderr: '' }),
        }),
      ),
    ).rejects.toThrow(NoDefaultGatewayError);
  });

  test('unsupported platform throws NoDefaultGatewayError', async () => {
    await expect(
      getDefaultGateway(rt({ platform: () => 'win32' })),
    ).rejects.toThrow(NoDefaultGatewayError);
  });
});

describe('getDnsServers', () => {
  test('parses nameserver lines, dedupes, preserves order', async () => {
    const servers = await getDnsServers(
      rt({
        readFile: async () =>
          [
            '# comment line',
            '; another comment',
            'search example.com',
            'nameserver 1.1.1.1',
            'nameserver 8.8.8.8',
            'nameserver 1.1.1.1', // duplicate
            '',
          ].join('\n'),
      }),
    );
    expect(servers).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  test('returns [] when /etc/resolv.conf is unreadable', async () => {
    const servers = await getDnsServers(
      rt({
        readFile: async () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(servers).toEqual([]);
  });
});

describe('computeFingerprint', () => {
  test('honors override env var (returns verbatim)', async () => {
    const fp = await computeFingerprint(
      rt({
        env: { [OVERRIDE_ENV]: 'route=test;dns=test' } as NodeJS.ProcessEnv,
      }),
    );
    expect(fp).toBe('route=test;dns=test');
  });

  test('returns route=unknown;dns= when gateway lookup fails', async () => {
    const fp = await computeFingerprint(
      rt({
        platform: () => 'linux',
        execFile: async () => ({ stdout: '', stderr: '' }),
        readFile: async () => 'nameserver 1.1.1.1',
      }),
    );
    expect(fp).toBe('route=unknown;dns=');
  });

  test('happy-path composes route= + dns=', async () => {
    const fp = await computeFingerprint(
      rt({
        platform: () => 'linux',
        execFile: async () => ({
          stdout: 'default via 192.168.1.1 dev eth0\n',
          stderr: '',
        }),
        readFile: async () => 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n',
      }),
    );
    expect(fp).toBe('route=192.168.1.1;dns=1.1.1.1,8.8.8.8');
  });

  test('dns lookup failure yields empty dns segment', async () => {
    const fp = await computeFingerprint(
      rt({
        platform: () => 'linux',
        execFile: async () => ({
          stdout: 'default via 192.168.1.1 dev eth0\n',
          stderr: '',
        }),
        readFile: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(fp).toBe('route=192.168.1.1;dns=');
  });
});
