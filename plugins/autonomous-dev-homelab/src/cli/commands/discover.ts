/**
 * `autonomous-dev-homelab discover` command handler. Implements
 * SPEC-001-1-04 §"`discover` Behavior".
 *
 * Composes ConsentManager (SPEC-001-1-01), PlatformProber (SPEC-001-1-02),
 * and InventoryManager (SPEC-001-1-03). Holds NO discovery, consent, or
 * storage logic of its own -- only argument plumbing, exit codes, and
 * output formatting.
 *
 * Algorithm (per spec):
 * 1. Resolve target CIDRs (either `--cidr`, or all unexpired+matching
 *    consents from the consent file).
 * 2. For each CIDR: ensure consent (prompting unless --no-prompt/--json),
 *    scan, then upsert each match into the inventory.
 * 3. Emit either human-readable lines or a single-line JSON object.
 *
 * Re-discovery semantics: an existing inventory entry with the same
 * deterministic id (`<type>-<ip-with-dashes>`) is `updatePlatform`'d,
 * not duplicated. New IDs are `addPlatform`'d.
 */

import { ConsentManager } from '../../consent/manager.js';
import { PlatformProber } from '../../discovery/prober.js';
import { InventoryManager } from '../../discovery/inventory.js';
import { getDefaultPermittedPorts } from '../../discovery/fingerprints.js';
import {
  MCPDiscovery,
  type HomelabPlatformId,
  type MCPServerInfo,
} from '../../connection/mcp-discovery.js';
import type { Consent } from '../../consent/types.js';
import type { MatchedPlatform } from '../../discovery/types.js';
import type { Platform } from '../../discovery/inventory-types.js';
import {
  EXIT_OK,
  EXIT_USAGE,
  EXIT_NO_CONSENT,
  EXIT_PARTIAL,
} from '../exit-codes.js';
import { printError, printJson, type OutputStreams, DEFAULT_STREAMS } from '../output.js';

/** Strict CIDR check used at argument-validation time. */
const CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(3[0-2]|[12]?\d)$/;

export interface DiscoverArgs {
  cidr?: string;
  json?: boolean;
  noPrompt?: boolean;
}

export interface DiscoverDeps {
  consentManager: ConsentManager;
  prober: PlatformProber;
  inventoryManager: InventoryManager;
  /** Override clock for tests (used for `last_seen` / `discovered_at`). */
  now?: () => Date;
  streams?: OutputStreams;
  /**
   * Optional override for enumerating consented CIDRs when `--cidr` is
   * absent. The default reads from the same file the ConsentManager uses,
   * but ConsentManager doesn't expose an enumerate API; tests inject a
   * fake. Production callers must provide one when `--cidr` is omitted.
   */
  listConsents?: () => Promise<Consent[]>;
  /**
   * Optional MCP discovery; when provided, each new/updated inventory
   * entry's `connection.mcp_endpoint` is set to the matching
   * `mcp-server-*` name (or `null` if the operator has not installed
   * one). When absent, the field is left untouched. Implements
   * SPEC-001-3-01 §"Inventory Wiring".
   */
  mcpDiscovery?: MCPDiscovery;
}

interface ScanReport {
  scanned: number;
  failed: number;
  matches: MatchedPlatform[];
  addedIds: string[];
  updatedIds: string[];
}

/** Build the deterministic inventory id from a match. */
function buildPlatformId(match: MatchedPlatform): string {
  return `${match.platformType}-${match.ip.replaceAll('.', '-')}`;
}

/**
 * Resolve the MCP endpoint name for an inventory `platformType`, given a
 * pre-built map. Returns `null` when MCP discovery is wired but no server
 * is installed for this platform (so the inventory clears stale state),
 * and `null` when MCP discovery is not wired (caller suppresses writes).
 */
function resolveMcpEndpoint(
  platformType: MatchedPlatform['platformType'],
  mcpByPlatform: Map<HomelabPlatformId, string> | null,
): string | null {
  if (mcpByPlatform === null) return null;
  const id = MCPDiscovery.toHomelabPlatformId(platformType);
  if (id === null) return null;
  return mcpByPlatform.get(id) ?? null;
}

/** Returns the first usable host inside the CIDR (.1 host bit set). */
function firstHostInCidr(cidr: string): string {
  const match = CIDR_REGEX.exec(cidr);
  if (!match) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const octets = [match[1], match[2], match[3], match[4]].map((o) => Number(o));
  const prefix = Number(match[5]);
  // eslint-disable-next-line no-bitwise
  const ip = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  // eslint-disable-next-line no-bitwise
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // eslint-disable-next-line no-bitwise
  const network = (ip & mask) >>> 0;
  // /32: the network is the only address. Otherwise, set host bit 1.
  const target = prefix === 32 ? network : (network + 1) >>> 0;
  // eslint-disable-next-line no-bitwise
  return `${(target >>> 24) & 0xff}.${(target >>> 16) & 0xff}.${(target >>> 8) & 0xff}.${target & 0xff}`;
}

/**
 * Top-level entrypoint. Returns an exit code; does NOT call process.exit.
 * Tests invoke this directly and assert on the returned code + emitted
 * output streams.
 */
export async function runDiscover(args: DiscoverArgs, deps: DiscoverDeps): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;
  // SPEC: --json implies --no-prompt (interactive prompts and JSON output
  // are mutually exclusive).
  const noPrompt = args.noPrompt === true || jsonMode;
  const now = deps.now ?? (() => new Date());

  // 1. Validate CIDR if supplied.
  if (args.cidr !== undefined && !CIDR_REGEX.test(args.cidr)) {
    printError(`invalid CIDR: ${args.cidr}`, streams);
    return EXIT_USAGE;
  }

  // 2. Resolve target CIDR list.
  let cidrs: string[];
  if (args.cidr !== undefined) {
    cidrs = [args.cidr];
  } else {
    if (!deps.listConsents) {
      printError('cannot enumerate consented CIDRs (no listConsents provided); pass --cidr', streams);
      return EXIT_NO_CONSENT;
    }
    const consents = await deps.listConsents();
    const nowMs = now().getTime();
    let currentFingerprint: string | null = null;
    const eligible: string[] = [];
    for (const c of consents) {
      const expires = Date.parse(c.expires_at);
      if (Number.isNaN(expires) || nowMs >= expires) continue;
      if (c.network_fingerprint !== undefined) {
        if (currentFingerprint === null) {
          currentFingerprint = await deps.consentManager.networkFingerprint();
        }
        if (c.network_fingerprint !== currentFingerprint) continue;
      }
      eligible.push(c.cidr);
    }
    if (eligible.length === 0) {
      printError(
        'no consented CIDRs available; pass --cidr to scan a new range',
        streams,
      );
      return EXIT_NO_CONSENT;
    }
    cidrs = eligible;
  }

  // 2b. Resolve MCP server map (best-effort; null when discovery not wired).
  let mcpByPlatform: Map<HomelabPlatformId, string> | null = null;
  if (deps.mcpDiscovery !== undefined) {
    let mcpServers: MCPServerInfo[] = [];
    try {
      mcpServers = await deps.mcpDiscovery.discover();
    } catch {
      // Discovery is best-effort; an unexpected throw must not block scan.
      mcpServers = [];
    }
    mcpByPlatform = new Map<HomelabPlatformId, string>();
    for (const s of mcpServers) {
      mcpByPlatform.set(s.platform, s.name);
    }
  }

  // 3. Per-CIDR: ensure consent, scan, write inventory.
  const report: ScanReport = {
    scanned: 0,
    failed: 0,
    matches: [],
    addedIds: [],
    updatedIds: [],
  };
  const linesForHuman: string[] = [];

  for (const cidr of cidrs) {
    let consent: Consent | null;
    try {
      consent = await deps.consentManager.checkConsent(firstHostInCidr(cidr));
    } catch (err) {
      printError(`failed to check consent for ${cidr}: ${(err as Error).message}`, streams);
      report.failed++;
      continue;
    }

    if (consent === null) {
      if (noPrompt) {
        printError(
          `no consent for ${cidr}; rerun without --no-prompt to approve`,
          streams,
        );
        if (args.cidr !== undefined) {
          // Single-CIDR case: no ambiguity, exit 2 directly.
          return EXIT_NO_CONSENT;
        }
        report.failed++;
        continue;
      }
      const approved = await deps.consentManager.requestConsent(
        cidr,
        getDefaultPermittedPorts(),
        ['http_probe'],
      );
      if (!approved) {
        printError(`consent for ${cidr} was rejected`, streams);
        return EXIT_NO_CONSENT;
      }
      consent = await deps.consentManager.checkConsent(firstHostInCidr(cidr));
      if (consent === null) {
        // Should not happen: requestConsent returned true so the entry was
        // written, but the freshly-loaded file disagrees. Defensive: treat
        // as failure.
        printError(`consent for ${cidr} was approved but not retrievable`, streams);
        report.failed++;
        continue;
      }
    }

    let matches: MatchedPlatform[];
    try {
      matches = await deps.prober.scan(cidr, consent);
    } catch (err) {
      printError(`scan failed for ${cidr}: ${(err as Error).message}`, streams);
      report.failed++;
      continue;
    }

    report.scanned++;
    report.matches.push(...matches);

    for (const match of matches) {
      const id = buildPlatformId(match);
      const existing = await deps.inventoryManager.getPlatform(id);
      const nowIso = now().toISOString();
      // Compute MCP endpoint per-platform when discovery is wired. Null
      // explicitly clears stale endpoints (operator uninstalled a server).
      const mcpEndpoint = resolveMcpEndpoint(match.platformType, mcpByPlatform);
      if (existing) {
        const updateConn =
          mcpByPlatform !== null
            ? {
                ...(existing.connection ?? {}),
                mcp_endpoint: mcpEndpoint,
              }
            : existing.connection;
        await deps.inventoryManager.updatePlatform(id, {
          last_seen: nowIso,
          metadata: {
            ...(existing.metadata ?? {}),
            confidence: match.confidence,
          },
          ...(mcpByPlatform !== null ? { connection: updateConn } : {}),
        });
        report.updatedIds.push(id);
        if (!jsonMode) {
          linesForHuman.push(
            `${match.platformType} @ ${match.ip}:${match.port} (confidence: ${match.confidence.toFixed(2)}) [updated]`,
          );
        }
      } else {
        const platform: Platform = {
          id,
          type: match.platformType,
          host: match.ip,
          port: match.port,
          discovered_at: nowIso,
          last_seen: nowIso,
          metadata: {
            confidence: match.confidence,
            protocol: match.protocol,
          },
          ...(mcpByPlatform !== null
            ? {
                connection: { mcp_endpoint: mcpEndpoint },
              }
            : {}),
        };
        await deps.inventoryManager.addPlatform(platform);
        report.addedIds.push(id);
        if (!jsonMode) {
          linesForHuman.push(
            `${match.platformType} @ ${match.ip}:${match.port} (confidence: ${match.confidence.toFixed(2)}) [new]`,
          );
        }
      }
    }
  }

  // 4. Output.
  if (jsonMode) {
    printJson(
      {
        scanned_cidrs: cidrs.slice(0, report.scanned + report.failed),
        matches: report.matches,
        added_ids: report.addedIds,
        updated_ids: report.updatedIds,
      },
      streams,
    );
  } else {
    for (const line of linesForHuman) {
      streams.stdout(line + '\n');
    }
    streams.stdout(
      `Discovered ${report.matches.length} platforms (${report.addedIds.length} new, ${report.updatedIds.length} updated) across ${report.scanned} CIDRs.\n`,
    );
  }

  // 5. Exit code: success if at least one CIDR scanned cleanly; partial
  //    if any CIDR failed; full failure (kept as no-consent in degenerate
  //    case where every CIDR failed).
  if (report.failed > 0 && report.scanned === 0) {
    return EXIT_NO_CONSENT;
  }
  if (report.failed > 0) {
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
}
