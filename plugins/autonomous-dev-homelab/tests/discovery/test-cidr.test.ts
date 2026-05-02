/**
 * enumerateHosts edge-case tests.
 */

import { enumerateHosts } from '../../src/discovery/cidr';

function collect(cidr: string): string[] {
  return Array.from(enumerateHosts(cidr));
}

describe('enumerateHosts', () => {
  test('/32 yields the single address', () => {
    expect(collect('127.0.0.1/32')).toEqual(['127.0.0.1']);
  });

  test('/31 yields both addresses (RFC 3021)', () => {
    expect(collect('192.168.0.0/31')).toEqual(['192.168.0.0', '192.168.0.1']);
  });

  test('/30 excludes network and broadcast', () => {
    expect(collect('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
  });

  test('/29 yields 6 hosts', () => {
    expect(collect('10.0.0.0/29')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.4',
      '10.0.0.5',
      '10.0.0.6',
    ]);
  });

  test('/24 yields 254 hosts', () => {
    const hosts = collect('192.168.1.0/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts[253]).toBe('192.168.1.254');
  });

  test('throws on invalid CIDR text', () => {
    expect(() => collect('not-a-cidr')).toThrow(/invalid CIDR/);
  });

  test('throws on octet > 255', () => {
    expect(() => collect('300.0.0.0/24')).toThrow(/invalid CIDR/);
  });

  test('throws on prefix > 32', () => {
    expect(() => collect('192.168.0.0/33')).toThrow(/invalid CIDR/);
  });
});
