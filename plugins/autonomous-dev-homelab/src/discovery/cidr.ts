/**
 * IPv4 CIDR enumeration. Implements SPEC-001-1-02 §"CIDR Enumeration".
 *
 * - /32: yields the single address.
 * - /31: yields both addresses (RFC 3021 point-to-point).
 * - /30 and broader: excludes network address and broadcast address.
 * - Throws on invalid CIDR.
 */

const CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(3[0-2]|[12]?\d)$/;

function intToIp(n: number): string {
  // eslint-disable-next-line no-bitwise
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

export function* enumerateHosts(cidr: string): IterableIterator<string> {
  const match = CIDR_REGEX.exec(cidr);
  if (!match) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefix = Number(match[5]);
  // eslint-disable-next-line no-bitwise
  const ip = (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
  // eslint-disable-next-line no-bitwise
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // eslint-disable-next-line no-bitwise
  const network = (ip & mask) >>> 0;
  // eslint-disable-next-line no-bitwise
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  if (prefix === 32) {
    yield intToIp(network);
    return;
  }
  if (prefix === 31) {
    // RFC 3021: both addresses are usable.
    yield intToIp(network);
    yield intToIp(network + 1);
    return;
  }
  // Skip network and broadcast for /30 and broader.
  for (let n = network + 1; n < broadcast; n++) {
    yield intToIp(n >>> 0);
  }
}
