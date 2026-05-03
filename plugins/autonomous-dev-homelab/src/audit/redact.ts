/**
 * Best-effort secret redaction for audit `command_executed` payloads.
 * SPEC-001-3-02 §Notes ("Command redaction").
 *
 * This is NOT a security boundary — operators must not assume the audit
 * log is safe to share with untrusted parties. The redaction blocks the
 * common shapes (passwords on the command line, bearer tokens, long
 * base64-ish strings) so that routine review does not casually leak
 * credentials.
 *
 * Patterns covered:
 *   - `password=<value>` / `--password <value>` / `--password=<value>`
 *   - `--token <value>` / `--token=<value>`
 *   - `Authorization: Bearer <value>`
 *   - Base64-ish runs longer than 20 chars adjacent to whitespace.
 *
 * Each match is replaced with the literal sentinel `[REDACTED]`.
 */

const REDACTION_TOKEN = '[REDACTED]';

interface RedactionRule {
  /** Regex with one capture group around the secret value to mask. */
  pattern: RegExp;
  /** Function returning the replacement string given the original match. */
  replace: (match: string, secret: string) => string;
}

const RULES: RedactionRule[] = [
  // password=foo or password="foo"
  {
    pattern: /(password\s*=\s*)("[^"]+"|'[^']+'|\S+)/gi,
    replace: (_, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
  // --password foo / --password=foo
  {
    pattern: /(--password(?:[=\s]+))(\S+)/gi,
    replace: (_, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
  // --token foo / --token=foo
  {
    pattern: /(--token(?:[=\s]+))(\S+)/gi,
    replace: (_, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
  // Authorization: Bearer <value>
  {
    pattern: /(Authorization:\s*Bearer\s+)(\S+)/gi,
    replace: (_, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
  // Long base64-ish runs (>=24 chars of [A-Za-z0-9+/=_-]) bordered by
  // whitespace or string ends. Conservative threshold to avoid masking
  // ordinary words.
  {
    pattern: /(^|\s)([A-Za-z0-9+/=_-]{24,})(?=\s|$)/g,
    replace: (_, prefix: string) => `${prefix}${REDACTION_TOKEN}`,
  },
];

/**
 * Apply all redaction rules in order. Returns the redacted string. The
 * input is not mutated; safe to call on operator-supplied commands
 * before they hit the audit log.
 */
export function redactCommand(command: string): string {
  let out = command;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}
