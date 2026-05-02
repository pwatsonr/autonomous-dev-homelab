/**
 * CLI exit-code constants. Implements SPEC-001-1-04 §"Exit Codes".
 *
 * Stable contract for scripted callers:
 * - 0  full success
 * - 1  bad CLI usage (unknown flag, malformed CIDR, bad enum value)
 * - 2  consent missing or rejected
 * - 3  partial success (some CIDRs scanned, some failed)
 * - 10 unexpected internal error (caught at top level)
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_NO_CONSENT = 2;
export const EXIT_PARTIAL = 3;
export const EXIT_INTERNAL = 10;
