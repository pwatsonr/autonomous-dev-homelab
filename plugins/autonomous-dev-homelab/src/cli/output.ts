/**
 * Tiny output helpers for the homelab CLI. Implements SPEC-001-1-04
 * §"Output Helpers".
 *
 * Conventions:
 * - All data output goes to stdout via the injected `stdout` writer.
 * - All error output goes to stderr via the injected `stderr` writer.
 * - JSON output is always single-line (newline-terminated) so it pipes
 *   cleanly into `jq -c` / log lines.
 * - Tables are fixed-width ASCII; pretty rendering with cli-table is
 *   intentionally out of scope for v1.
 */

export interface OutputStreams {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export const DEFAULT_STREAMS: OutputStreams = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

/**
 * Emits a fixed-width ASCII table to `streams.stdout`. Empty rows produce
 * just the header. Cell values are coerced to strings; missing keys render
 * as the empty string.
 */
export function printTable(
  rows: Record<string, string>[],
  columns: string[],
  streams: OutputStreams = DEFAULT_STREAMS,
): void {
  const widths = columns.map((col) => {
    let max = col.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });
  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ');
  streams.stdout(renderRow(columns) + '\n');
  for (const row of rows) {
    streams.stdout(renderRow(columns.map((c) => row[c] ?? '')) + '\n');
  }
}

/** Emits `value` as a single-line JSON document followed by a newline. */
export function printJson(value: unknown, streams: OutputStreams = DEFAULT_STREAMS): void {
  streams.stdout(JSON.stringify(value) + '\n');
}

/** Emits `ERROR: <msg>\n` to stderr. */
export function printError(msg: string, streams: OutputStreams = DEFAULT_STREAMS): void {
  streams.stderr(`ERROR: ${msg}\n`);
}
