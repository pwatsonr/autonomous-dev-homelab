/**
 * Deterministic JSON canonicalizer used as the HMAC input for the
 * homelab audit log. SPEC-001-3-02. Mirrors the recipe in
 * `autonomous-dev/plugins/autonomous-dev/intake/chains/canonical-json.ts`
 * (RFC 8785 / "JCS"-style):
 *
 *   - Object keys sorted lexicographically at every nesting level.
 *   - No whitespace.
 *   - JSON.stringify for strings/numbers (enforces RFC 8259 escapes;
 *     rejects NaN/Infinity).
 *   - Arrays preserve insertion order.
 *   - undefined/function/symbol/BigInt → TypeError.
 */

export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(
        `canonicalJson: non-finite number is not JSON-serializable: ${value as number}`,
      );
    }
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') {
    throw new TypeError('canonicalJson: BigInt is not JSON-serializable');
  }
  if (t === 'undefined') {
    throw new TypeError('canonicalJson: undefined is not JSON-serializable');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalJson: ${t} is not JSON-serializable`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) {
        throw new TypeError(
          `canonicalJson: undefined value at key '${k}' is not JSON-serializable`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${encode(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value type ${t}`);
}
