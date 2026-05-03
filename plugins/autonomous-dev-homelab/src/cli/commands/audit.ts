/**
 * `autonomous-dev-homelab audit ...` subcommand group. Implements
 * SPEC-001-3-03 §"`audit verify`" and §"`audit query`".
 *
 * Subcommands:
 *   audit verify [--json]
 *   audit query  [--platform <id>] [--event <type>] [--since <iso-ts>]
 *                [--actor <user>] [--limit <n>] [--json]
 *
 * Both commands read `<homelab-data>/audit.log` (NDJSON, one entry per
 * line) and the audit key from `<homelab-data>/.audit-key`. They do not
 * write or rotate state. `audit verify` recomputes each entry's HMAC
 * against the prior entry's HMAC and the canonicalized payload (matching
 * the writer in SPEC-001-3-02).
 *
 * Exit codes (per SPEC):
 *   0  success / clean log
 *   1  operator error: bad input, tampered log
 *   2  internal error: unexpected I/O failure (caller's `runCli` wraps
 *      thrown errors and returns EXIT_INTERNAL = 10).
 */

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import { Command } from 'commander';
import { canonicalJson } from '../../audit/canonical-json.js';
import { AuditKeyStore } from '../../audit/key-store.js';
import {
  type AuditEntry,
  type AuditEventType,
  GENESIS_PREV_HMAC,
} from '../../audit/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

export interface AuditCommandDeps {
  /** Absolute path to `<homelab-data>/audit.log`. */
  logPath: string;
  /** Key store used to load the HMAC key for verification. */
  keyStore: AuditKeyStore;
  streams?: OutputStreams;
}

export interface AuditCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

/** Build the `audit` Commander subcommand for tests + cli/index.ts. */
export function buildAuditCommand(deps: AuditCommandDeps): AuditCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('audit').description(
    'Verify and query the homelab audit log.',
  );

  cmd
    .command('verify')
    .description('Walk the entire audit log and verify each HMAC + seq.')
    .option('--json', 'emit a JSON result document')
    .action(async (cmdOpts: { json?: boolean }): Promise<void> => {
      lastExit = await runAuditVerify(cmdOpts, deps, streams);
    });

  cmd
    .command('query')
    .description('Stream filtered audit entries.')
    .option('--platform <id>', 'exact-match platform filter')
    .option('--event <type>', 'exact-match event filter')
    .option('--since <iso>', 'YYYY-MM-DD or full ISO-8601 timestamp lower bound (inclusive)')
    .option('--actor <user>', 'exact-match actor filter')
    .option(
      '--limit <n>',
      'maximum entries to return (default 100; 0 = unlimited)',
      (v) => Number.parseInt(v, 10),
      100,
    )
    .option('--json', 'emit a JSON array on stdout')
    .action(
      async (cmdOpts: {
        platform?: string;
        event?: string;
        since?: string;
        actor?: string;
        limit: number;
        json?: boolean;
      }): Promise<void> => {
        lastExit = await runAuditQuery(cmdOpts, deps, streams);
      },
    );

  return {
    command: cmd,
    lastExitCode: () => lastExit,
  };
}

// ===== verify ============================================================

interface VerifyResult {
  ok: boolean;
  entries_verified: number;
  first_seq: number | null;
  last_seq: number | null;
  failed_at_seq: number | null;
  reason: 'hmac_mismatch' | 'seq_gap' | 'parse_error' | null;
}

async function runAuditVerify(
  opts: { json?: boolean },
  deps: AuditCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(deps.logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const empty: VerifyResult = {
        ok: true,
        entries_verified: 0,
        first_seq: null,
        last_seq: null,
        failed_at_seq: null,
        reason: null,
      };
      if (opts.json === true) {
        printJson(
          { ok: true, entries_verified: 0, first_seq: null, last_seq: null },
          streams,
        );
      } else {
        streams.stdout('audit log: 0 entries verified, chain intact\n');
      }
      void empty;
      return EXIT_OK;
    }
    return failWithError(err as Error, opts.json === true, streams);
  }

  const key = await deps.keyStore.getKey();
  let prevHmac = GENESIS_PREV_HMAC;
  let prevSeq = 0;
  let entriesVerified = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  let failedAtSeq: number | null = null;
  let reason: VerifyResult['reason'] = null;

  // Trim trailing newline; ignore truly-empty file already handled above.
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (text === '') {
    if (opts.json === true) {
      printJson(
        { ok: true, entries_verified: 0, first_seq: null, last_seq: null },
        streams,
      );
    } else {
      streams.stdout('audit log: 0 entries verified, chain intact\n');
    }
    return EXIT_OK;
  }
  const lines = text.split('\n');

  for (const line of lines) {
    if (line === '') continue;
    let parsed: AuditEntry;
    try {
      parsed = JSON.parse(line) as AuditEntry;
    } catch {
      reason = 'parse_error';
      failedAtSeq = prevSeq + 1;
      break;
    }
    if (typeof parsed.seq !== 'number' || typeof parsed.hmac !== 'string') {
      reason = 'parse_error';
      failedAtSeq = prevSeq + 1;
      break;
    }
    // seq monotonicity: each entry's seq must be exactly prevSeq + 1.
    if (parsed.seq !== prevSeq + 1) {
      reason = 'seq_gap';
      failedAtSeq = parsed.seq;
      break;
    }
    // Recompute HMAC over canonical(entry-minus-hmac).
    const minus: Record<string, unknown> = {
      actor: parsed.actor,
      event: parsed.event,
      payload: parsed.payload,
      platform: parsed.platform,
      seq: parsed.seq,
      timestamp: parsed.timestamp,
    };
    const expected = crypto
      .createHmac('sha256', key)
      .update(prevHmac + canonicalJson(minus))
      .digest('hex');
    if (expected !== parsed.hmac) {
      reason = 'hmac_mismatch';
      failedAtSeq = parsed.seq;
      break;
    }
    if (firstSeq === null) firstSeq = parsed.seq;
    lastSeq = parsed.seq;
    prevHmac = parsed.hmac;
    prevSeq = parsed.seq;
    entriesVerified++;
  }

  const ok = failedAtSeq === null;
  if (opts.json === true) {
    if (ok) {
      printJson(
        {
          ok: true,
          entries_verified: entriesVerified,
          first_seq: firstSeq,
          last_seq: lastSeq,
        },
        streams,
      );
    } else {
      printJson(
        {
          ok: false,
          entries_verified: entriesVerified,
          failed_at_seq: failedAtSeq,
          reason,
        },
        streams,
      );
    }
  } else if (ok) {
    streams.stdout(`audit log: ${entriesVerified} entries verified, chain intact\n`);
  } else {
    printError(
      `audit log verification failed at seq ${failedAtSeq ?? '?'}: ${reason ?? 'unknown'}`,
      streams,
    );
  }
  return ok ? EXIT_OK : EXIT_USAGE;
}

function failWithError(err: Error, jsonMode: boolean, streams: OutputStreams): number {
  if (jsonMode) {
    printJson(
      { ok: false, error: err.message, code: 'IO_ERROR' },
      streams,
    );
  } else {
    printError(err.message, streams);
  }
  return EXIT_USAGE;
}

// ===== query =============================================================

interface QueryFilters {
  platform?: string;
  event?: string;
  actor?: string;
  sinceMs?: number;
  limit: number;
  json: boolean;
}

async function runAuditQuery(
  opts: {
    platform?: string;
    event?: string;
    since?: string;
    actor?: string;
    limit: number;
    json?: boolean;
  },
  deps: AuditCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const filters = parseFilters(opts);
  if (filters instanceof Error) {
    if (opts.json === true) {
      printJson(
        { ok: false, error: filters.message, code: 'BAD_FILTER' },
        streams,
      );
    } else {
      printError(filters.message, streams);
    }
    return EXIT_USAGE;
  }

  let raw: string;
  try {
    raw = await fs.readFile(deps.logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No log → empty result.
      if (filters.json) {
        streams.stdout('[]\n');
      }
      return EXIT_OK;
    }
    return failWithError(err as Error, filters.json, streams);
  }

  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const matches: AuditEntry[] = [];
  if (text !== '') {
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let parsed: AuditEntry;
      try {
        parsed = JSON.parse(line) as AuditEntry;
      } catch {
        // Skip malformed lines silently — verify is the place to surface
        // structural issues; query just iterates.
        continue;
      }
      if (filters.platform !== undefined && parsed.platform !== filters.platform) continue;
      if (filters.event !== undefined && parsed.event !== filters.event) continue;
      if (filters.actor !== undefined && parsed.actor !== filters.actor) continue;
      if (filters.sinceMs !== undefined) {
        const ts = Date.parse(parsed.timestamp);
        if (Number.isNaN(ts) || ts < filters.sinceMs) continue;
      }
      matches.push(parsed);
    }
  }
  // Apply limit: take the LAST N matches when limit > 0 (most-recent), or
  // all when limit === 0. Output is in chronological order regardless.
  let trimmed = matches;
  if (filters.limit > 0 && matches.length > filters.limit) {
    trimmed = matches.slice(matches.length - filters.limit);
  }

  if (filters.json) {
    printJson(trimmed, streams);
  } else if (trimmed.length === 0) {
    streams.stdout('No matching entries.\n');
  } else {
    for (const entry of trimmed) {
      streams.stdout(formatPlainEntry(entry) + '\n');
    }
  }
  return EXIT_OK;
}

function parseFilters(opts: {
  platform?: string;
  event?: string;
  since?: string;
  actor?: string;
  limit: number;
  json?: boolean;
}): QueryFilters | Error {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 100;
  if (limit < 0) {
    return new Error(`--limit must be >= 0; got ${limit}`);
  }
  let sinceMs: number | undefined;
  if (opts.since !== undefined) {
    const parsed = parseSince(opts.since);
    if (parsed === null) {
      return new Error(`invalid --since: ${opts.since} (expected YYYY-MM-DD or ISO-8601)`);
    }
    sinceMs = parsed;
  }
  const out: QueryFilters = {
    limit,
    json: opts.json === true,
  };
  if (opts.platform !== undefined) out.platform = opts.platform;
  if (opts.event !== undefined) out.event = opts.event;
  if (opts.actor !== undefined) out.actor = opts.actor;
  if (sinceMs !== undefined) out.sinceMs = sinceMs;
  return out;
}

function parseSince(s: string): number | null {
  // YYYY-MM-DD → midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function formatPlainEntry(entry: AuditEntry): string {
  const platform = entry.platform ?? '-';
  const payloadHints = formatPayloadHint(entry.event, entry.payload);
  return `${entry.timestamp}  ${entry.actor}  ${platform}  ${entry.event}${
    payloadHints !== '' ? '  ' + payloadHints : ''
  }`;
}

function formatPayloadHint(event: AuditEventType, payload: Record<string, unknown>): string {
  const parts: string[] = [];
  // Pull a few well-known fields for readability; full detail in --json.
  for (const k of ['serial', 'fingerprint', 'cidr', 'exit_code', 'principal']) {
    const v = payload[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${String(v)}`);
  }
  void event;
  return parts.join(' ');
}
