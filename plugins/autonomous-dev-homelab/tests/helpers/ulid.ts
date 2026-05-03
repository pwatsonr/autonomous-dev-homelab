/**
 * Deterministic test-only ULID generator. Produces a 26-char Crockford
 * base32 string matching the production ULID regex
 * `/^[0-9A-HJKMNP-TV-Z]{26}$/`.
 *
 * NOT cryptographically random — counter-based to keep tests deterministic.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let counter = 0;

export function ulid(): string {
  counter += 1;
  // 26-char string. First 10 chars look timestampy, last 16 chars derived
  // from counter; both pulled from the legal alphabet only.
  const ts = '01ARZ3NDEK';
  const tail = counter.toString(32).toUpperCase().padStart(16, '0');
  // toString(32) uses 0-9a-v; map any out-of-alphabet chars to 'Z'.
  const safeTail = Array.from(tail)
    .map((c) => (ALPHABET.includes(c) ? c : 'Z'))
    .join('');
  return ts + safeTail;
}

export function resetUlidCounter(): void {
  counter = 0;
}
