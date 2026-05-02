/**
 * Tiny JSONPath helper. SPEC-001-1-02 only needs `$.a.b.c` style lookups
 * (dot-separated paths from the root); we deliberately avoid the
 * `jsonpath-plus` dependency to keep the install footprint small.
 *
 * Supported syntax:
 *   - `$` — root
 *   - `$.foo` / `$.foo.bar` — nested object access
 *   - returns `undefined` when any segment is missing
 *
 * Unsupported (out of scope for v1): array indexing, wildcards,
 * filters, recursive descent. If a fingerprint requires those, extend
 * this module deliberately rather than swapping in a library that
 * `eval`s strings.
 */

export function jsonPathLookup(root: unknown, path: string): unknown {
  if (path === '$' || path === '') return root;
  if (!path.startsWith('$.')) {
    throw new Error(`unsupported jsonPath (must start with "$." or be "$"): ${path}`);
  }
  const segments = path.slice(2).split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
