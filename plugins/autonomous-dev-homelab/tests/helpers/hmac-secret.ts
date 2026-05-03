/**
 * Test helper that ensures `HOMELAB_HMAC_SECRET` is set before importing
 * any module that signs/verifies. Call `ensureHmacSecret()` in
 * `beforeAll`.
 */

const TEST_SECRET = 'a'.repeat(32);

export function ensureHmacSecret(): void {
  if (
    process.env['HOMELAB_HMAC_SECRET'] === undefined ||
    process.env['HOMELAB_HMAC_SECRET'] === ''
  ) {
    process.env['HOMELAB_HMAC_SECRET'] = TEST_SECRET;
  }
}
