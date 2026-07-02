/**
 * Audit event redactor and string redaction utilities.
 * SPEC: REQ-000055 §2.6, §3.2.
 *
 * - `redactAuditEvent` strips REDACTED_KEYS from audit event payloads and
 *   emits a SECRET_LEAK_DETECTED marker when hits are found.
 * - `redact` strips secret-looking patterns from human-readable strings.
 * - `installRedactorSink` wraps an AuditWriter to apply redaction before
 *   every write.
 */

/**
 * Field names that MUST NOT appear in any audit event value position.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'value',
  'secret',
  'token',
  'password',
  'key',
  'private_key',
  'privateKey',
  'passphrase',
  'client_token',
  'role_id',
  'secret_id',
]);

/**
 * Fields that are always allowed in audit events even though they may
 * look like they reference secrets. These are safe identifiers, not
 * credential values.
 */
const AUDIT_WHITELIST: ReadonlySet<string> = new Set([
  'refHash',
  'credential_ref_hash',
  'vault_path',
  'vault_field',
]);

/** Per-event-type whitelist table. Only keys in this set are allowed. */
const EVENT_TYPE_WHITELIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'connect.test',
    new Set([
      'type',
      'host',
      'transport',
      'transport_reason',
      'outcome',
      'latency_ms',
      'credential_ref_hash',
      'occurred_at',
      'error',
    ]),
  ],
  [
    'autofix.propose',
    new Set([
      'type',
      'proposal_id',
      'observation_id',
      'target_host',
      'action_class',
      'ladder_level',
      'occurred_at',
    ]),
  ],
  [
    'autofix.dry-run',
    new Set(['type', 'proposal_id', 'gate_outcome', 'occurred_at']),
  ],
  [
    'action.cancelled',
    new Set(['type', 'action_id', 'reason', 'occurred_at']),
  ],
  [
    'SECRET_LEAK_DETECTED',
    new Set(['type', 'field', 'at']),
  ],
]);

/**
 * Recursively strip disallowed fields from an audit event payload.
 * Emits SECRET_LEAK_DETECTED marker events when REDACTED_KEYS are found.
 *
 * Returns `{ redacted, leakedFields }` so callers can emit the marker.
 */
function redactObject(
  obj: Record<string, unknown>,
): { redacted: Record<string, unknown>; leakedFields: string[] } {
  const redacted: Record<string, unknown> = {};
  const leakedFields: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (AUDIT_WHITELIST.has(key)) {
      redacted[key] = value;
      continue;
    }
    if (REDACTED_KEYS.has(key)) {
      redacted[key] = '<redacted>';
      leakedFields.push(key);
      continue;
    }
    // Recurse into nested objects
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = redactObject(value as Record<string, unknown>);
      redacted[key] = nested.redacted;
      leakedFields.push(...nested.leakedFields);
    } else {
      redacted[key] = value;
    }
  }

  return { redacted, leakedFields };
}

/**
 * Recursively strip disallowed fields from an audit event payload.
 * Also enforces per-event-type whitelist when the event has a `type` field.
 *
 * NOTE: This function collects leaked fields but does NOT emit the marker
 * event itself (that would require async). Use `installRedactorSink` for
 * the full pipeline.
 */
export function redactAuditEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const { redacted } = redactObject(event);

  // Apply per-event-type whitelist if available
  const eventType = typeof event['type'] === 'string' ? event['type'] : undefined;
  if (eventType !== undefined) {
    const allowedKeys = EVENT_TYPE_WHITELIST.get(eventType);
    if (allowedKeys !== undefined) {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(redacted)) {
        if (allowedKeys.has(k) || AUDIT_WHITELIST.has(k)) {
          filtered[k] = v;
        }
        // Keys not in the whitelist are silently dropped (not leaked)
      }
      return filtered;
    }
  }

  return redacted;
}

/**
 * Redact a message string for user output.
 * Replaces:
 * - 32+ char hex runs (probable tokens)
 * - Vault token patterns `hvs.*`
 * - PEM private key blocks
 * - AWS access key patterns `AKIA...`
 * - Slack bot token patterns `xoxb-...`
 */
export function redact(message: string): string {
  let result = message;

  // PEM private key blocks (multiline)
  result = result.replace(
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    '<redacted>',
  );

  // Vault tokens
  result = result.replace(/hvs\.[A-Za-z0-9._-]+/g, '<redacted>');

  // AWS access keys
  result = result.replace(/AKIA[0-9A-Z]{16}/g, '<redacted>');

  // Slack bot tokens
  result = result.replace(/xoxb-[A-Za-z0-9-]+/g, '<redacted>');

  // Long hex runs (32+ chars = probable token)
  result = result.replace(/\b[0-9a-fA-F]{32,}\b/g, '<redacted>');

  return result;
}

/**
 * Attach to an AuditWriter. Wraps writer.write to run redactAuditEvent first;
 * emits SECRET_LEAK_DETECTED marker event if a REDACTED_KEYS hit is found.
 */
export function installRedactorSink<
  W extends { write: (e: Record<string, unknown>) => Promise<void> },
>(writer: W): W {
  const originalWrite = writer.write.bind(writer);

  writer.write = async (event: Record<string, unknown>): Promise<void> => {
    const { redacted, leakedFields } = redactObject(event);

    await originalWrite(redacted);

    // Emit marker events for each leaked field
    for (const field of leakedFields) {
      const marker: Record<string, unknown> = {
        type: 'SECRET_LEAK_DETECTED',
        field,
        at: new Date().toISOString(),
      };
      await originalWrite(marker);
    }
  };

  return writer;
}
