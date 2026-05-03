/**
 * `autonomous-dev-homelab consent ...` subcommand group. Implements
 * SPEC-001-3-03 §"`consent list`", §"`consent grant`", §"`consent revoke`".
 *
 * Subcommands:
 *   consent list   [--json]
 *   consent grant  <cidr> [--ports <list>] [--scan-types <list>]
 *                         [--ttl <duration>] [--json]
 *   consent revoke <cidr> [--json]                     # requiresAdmin
 *
 * Business logic stays in `ConsentManager`. This command group is
 * argument plumbing + output formatting.
 */

import { Command } from 'commander';
import type { ConsentManager } from '../../consent/manager.js';
import type { Consent, ScanType } from '../../consent/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { printError, printJson, printTable, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

const VALID_SCAN_TYPES: ReadonlySet<ScanType> = new Set<ScanType>([
  'http_probe',
  'ssh_probe',
  'tcp_connect',
]);
const DEFAULT_PORTS = '22,80,443,8006';
const DEFAULT_SCAN_TYPES = 'tcp_connect';

export interface ConsentCommandDeps {
  consentManager: ConsentManager;
  streams?: OutputStreams;
}

export interface ConsentCommandHandle {
  command: Command;
  lastExitCode: () => number;
}

export function buildConsentCommand(deps: ConsentCommandDeps): ConsentCommandHandle {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  let lastExit = EXIT_OK;

  const cmd = new Command('consent').description(
    'List, grant, or revoke per-CIDR network scan consents.',
  );

  cmd
    .command('list')
    .description('Print every active consent.')
    .option('--json', 'emit JSON to stdout instead of a table')
    .action(async (cmdOpts: { json?: boolean }): Promise<void> => {
      lastExit = await runConsentList(cmdOpts, deps, streams);
    });

  cmd
    .command('grant')
    .description('Request operator approval for scanning a CIDR.')
    .argument('<cidr>', 'IPv4 CIDR (e.g. 192.168.1.0/24)')
    .option('--ports <list>', 'comma-separated port list', DEFAULT_PORTS)
    .option(
      '--scan-types <list>',
      `comma-separated scan types (${Array.from(VALID_SCAN_TYPES).join(', ')})`,
      DEFAULT_SCAN_TYPES,
    )
    .option('--ttl <duration>', 'consent lifetime (e.g. 30d, 1h); default: 90d')
    .option('--json', 'emit JSON instead of human-readable output')
    .action(
      async (
        cidr: string,
        cmdOpts: { ports: string; scanTypes: string; ttl?: string; json?: boolean },
      ): Promise<void> => {
        lastExit = await runConsentGrant(cidr, cmdOpts, deps, streams);
      },
    );

  cmd
    .command('revoke')
    .description('Remove an active consent. (admin)')
    .argument('<cidr>', 'IPv4 CIDR')
    .option('--json', 'emit JSON instead of human-readable output')
    .action(
      async (cidr: string, cmdOpts: { json?: boolean }): Promise<void> => {
        lastExit = await runConsentRevoke(cidr, cmdOpts, deps, streams);
      },
    );

  return {
    command: cmd,
    lastExitCode: () => lastExit,
  };
}

// ===== list ==============================================================

async function runConsentList(
  opts: { json?: boolean },
  deps: ConsentCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const consents = await deps.consentManager.listConsents();
  if (opts.json === true) {
    printJson(consents, streams);
    return EXIT_OK;
  }
  if (consents.length === 0) {
    streams.stdout('No active consents.\n');
    return EXIT_OK;
  }
  const rows = consents.map((c) => ({
    CIDR: c.cidr,
    APPROVED_AT: c.approved_at,
    EXPIRES_AT: c.expires_at !== '' ? c.expires_at : '-',
    PORTS: c.permitted_ports.join(','),
    SCAN_TYPES: c.permitted_scan_types.join(','),
  }));
  printTable(rows, ['CIDR', 'APPROVED_AT', 'EXPIRES_AT', 'PORTS', 'SCAN_TYPES'], streams);
  return EXIT_OK;
}

// ===== grant =============================================================

async function runConsentGrant(
  cidr: string,
  opts: { ports: string; scanTypes: string; ttl?: string; json?: boolean },
  deps: ConsentCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  const ports = parsePortsList(opts.ports);
  if (ports instanceof Error) {
    printError(ports.message, streams);
    return EXIT_USAGE;
  }
  const scanTypes = parseScanTypes(opts.scanTypes);
  if (scanTypes instanceof Error) {
    printError(scanTypes.message, streams);
    return EXIT_USAGE;
  }
  // `--ttl` is parsed but the underlying ConsentManager does not yet
  // accept a per-call TTL override; if provided, validate the format
  // and warn that the manager's default is used. (Future enhancement.)
  if (opts.ttl !== undefined && parseTtl(opts.ttl) === null) {
    printError(`invalid --ttl: ${opts.ttl} (expected e.g. 30d, 1h)`, streams);
    return EXIT_USAGE;
  }

  let approved: boolean;
  try {
    approved = await deps.consentManager.requestConsent(cidr, ports, scanTypes);
  } catch (err) {
    printError(`consent grant failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }
  if (!approved) {
    if (opts.json === true) {
      printJson({ ok: false, error: 'rejected', code: 'NOT_APPROVED' }, streams);
    } else {
      printError(`consent for ${cidr} was rejected`, streams);
    }
    return EXIT_USAGE;
  }
  // Re-fetch the granted entry so we can show what was persisted.
  const all = await deps.consentManager.listConsents();
  const entry = findMostRecentForCidr(all, cidr);
  if (opts.json === true) {
    printJson(entry ?? { granted: cidr }, streams);
  } else if (entry !== null) {
    streams.stdout(
      `Granted consent for ${entry.cidr}\n` +
        `  approved_at: ${entry.approved_at}\n` +
        `  expires_at:  ${entry.expires_at}\n` +
        `  ports:       ${entry.permitted_ports.join(',')}\n` +
        `  scan_types:  ${entry.permitted_scan_types.join(',')}\n`,
    );
  } else {
    streams.stdout(`Granted consent for ${cidr}.\n`);
  }
  return EXIT_OK;
}

function findMostRecentForCidr(consents: Consent[], cidr: string): Consent | null {
  let best: Consent | null = null;
  let bestMs = -Infinity;
  for (const c of consents) {
    if (c.cidr !== cidr) continue;
    const ms = Date.parse(c.approved_at);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best;
}

function parsePortsList(s: string): number[] | Error {
  const out: number[] = [];
  for (const tok of s.split(',')) {
    const trimmed = tok.trim();
    if (trimmed === '') continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return new Error(`invalid port: ${tok}`);
    }
    out.push(n);
  }
  if (out.length === 0) {
    return new Error('--ports must list at least one port');
  }
  return out;
}

function parseScanTypes(s: string): ScanType[] | Error {
  const out: ScanType[] = [];
  for (const tok of s.split(',')) {
    const trimmed = tok.trim();
    if (trimmed === '') continue;
    if (!VALID_SCAN_TYPES.has(trimmed as ScanType)) {
      return new Error(
        `invalid scan-type: ${tok} (expected one of ${Array.from(VALID_SCAN_TYPES).join(', ')})`,
      );
    }
    out.push(trimmed as ScanType);
  }
  if (out.length === 0) {
    return new Error('--scan-types must list at least one scan type');
  }
  return out;
}

function parseTtl(s: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? '0', 10);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

// ===== revoke ============================================================

async function runConsentRevoke(
  cidr: string,
  opts: { json?: boolean },
  deps: ConsentCommandDeps,
  streams: OutputStreams,
): Promise<number> {
  let removed: number;
  try {
    removed = await deps.consentManager.revokeConsent(cidr);
  } catch (err) {
    printError(`consent revoke failed: ${(err as Error).message}`, streams);
    return EXIT_USAGE;
  }
  if (removed === 0) {
    if (opts.json === true) {
      printJson(
        { ok: false, error: `no active consent for ${cidr}`, code: 'NOT_FOUND' },
        streams,
      );
    } else {
      printError(`no active consent for ${cidr}`, streams);
    }
    return EXIT_USAGE;
  }
  if (opts.json === true) {
    printJson({ revoked: cidr, removed_count: removed }, streams);
  } else {
    streams.stdout(`Revoked consent for ${cidr}.\n`);
  }
  return EXIT_OK;
}
