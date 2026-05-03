/**
 * `autonomous-dev-homelab inventory ...` command handlers. Implements
 * SPEC-001-1-04 §"`inventory list` Behavior" and SPEC-001-3-04 §"`inventory
 * get`" / §"`inventory remove`".
 *
 * - `list`   Read-only table/JSON of every platform.
 * - `get`    Read-only YAML-like dump of one platform record.
 * - `remove` Destructive (admin): revokes the cert via SSHCertificateManager
 *            then removes the inventory record. Atomic: if revocation
 *            fails the inventory is NOT touched.
 *
 * The handlers compose InventoryManager (SPEC-001-1-03) and
 * SSHCertificateManager (SPEC-001-2-01); they own only output formatting
 * and prompt plumbing.
 */

import * as readline from 'node:readline';
import * as yaml from 'js-yaml';
import { InventoryManager } from '../../discovery/inventory.js';
import type { Platform, PlatformType } from '../../discovery/inventory-types.js';
import type { SSHCertificateManager } from '../../ca/manager.js';
import { CAError } from '../../ca/types.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import {
  printError,
  printJson,
  printTable,
  type OutputStreams,
  DEFAULT_STREAMS,
} from '../output.js';

const VALID_PLATFORM_TYPES: ReadonlySet<PlatformType> = new Set<PlatformType>([
  'unraid',
  'proxmox-ve',
  'docker',
  'kubernetes',
  'docker-swarm',
  'unifi',
  'truenas',
]);

export interface InventoryListArgs {
  type?: string;
  json?: boolean;
}

export interface InventoryListDeps {
  inventoryManager: InventoryManager;
  streams?: OutputStreams;
}

function isPlatformType(s: string): s is PlatformType {
  return VALID_PLATFORM_TYPES.has(s as PlatformType);
}

export async function runInventoryList(
  args: InventoryListArgs,
  deps: InventoryListDeps,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const jsonMode = args.json === true;

  if (args.type !== undefined && !isPlatformType(args.type)) {
    printError(
      `invalid --type ${args.type}; expected one of ${Array.from(VALID_PLATFORM_TYPES).join(', ')}`,
      streams,
    );
    return EXIT_USAGE;
  }

  const platforms: Platform[] = await deps.inventoryManager.listPlatforms(
    args.type !== undefined ? { type: args.type as PlatformType } : undefined,
  );

  if (jsonMode) {
    printJson(platforms, streams);
    return EXIT_OK;
  }

  if (platforms.length === 0) {
    streams.stdout('no platforms discovered yet; run `discover --cidr <cidr>` to scan.\n');
    return EXIT_OK;
  }

  const rows = platforms.map((p) => ({
    ID: p.id,
    TYPE: p.type,
    'HOST:PORT': `${p.host}:${p.port}`,
    LAST_SEEN: p.last_seen,
  }));
  printTable(rows, ['ID', 'TYPE', 'HOST:PORT', 'LAST_SEEN'], streams);
  return EXIT_OK;
}

// ===== get =================================================================

export interface InventoryGetArgs {
  platformId: string;
  json?: boolean;
}

export interface InventoryGetDeps {
  inventoryManager: InventoryManager;
  streams?: OutputStreams;
}

/**
 * Print the full record for a single platform. Plain output is YAML-like
 * (uses js-yaml's dumper for stable indentation); --json emits the raw
 * record. Exits EXIT_USAGE when the id is unknown.
 */
export async function runInventoryGet(
  args: InventoryGetArgs,
  deps: InventoryGetDeps,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const platform = await deps.inventoryManager.getPlatform(args.platformId);
  if (platform === null) {
    printError(`no platform '${args.platformId}' in inventory`, streams);
    return EXIT_USAGE;
  }
  if (args.json === true) {
    printJson(platform, streams);
    return EXIT_OK;
  }
  // YAML-like plain dump; sortKeys keeps field order deterministic for tests
  // while js-yaml produces nested-friendly indentation that matches the
  // SPEC's "yaml-style" sample.
  const dumped = yaml.dump(platform, { noRefs: true, sortKeys: false });
  streams.stdout(dumped);
  return EXIT_OK;
}

// ===== remove ==============================================================

export interface InventoryRemoveArgs {
  platformId: string;
  json?: boolean;
  yes?: boolean;
}

export interface InventoryRemoveDeps {
  inventoryManager: InventoryManager;
  caManager: SSHCertificateManager;
  streams?: OutputStreams;
  /** Confirmation prompt; defaults to TTY readline. Tests inject. */
  confirm?: (msg: string) => Promise<boolean>;
  /** Returns true when stdin is interactive. Default: process.stdin.isTTY. */
  isTTY?: () => boolean;
}

/**
 * Atomically revoke the cert and drop the inventory record.
 *
 * Order matters: revoke FIRST so a failure leaves the inventory
 * unchanged. If revocation throws, propagate and abort -- the operator
 * sees the exact reason, and the inventory entry is preserved for retry.
 *
 * Without --yes (and a TTY), prompts; an empty / "n" reply exits 0 with
 * no changes. With --json or --yes, the prompt is skipped.
 */
export async function runInventoryRemove(
  args: InventoryRemoveArgs,
  deps: InventoryRemoveDeps,
): Promise<number> {
  const streams = deps.streams ?? DEFAULT_STREAMS;
  const platform = await deps.inventoryManager.getPlatform(args.platformId);
  if (platform === null) {
    printError(`no platform '${args.platformId}' in inventory`, streams);
    return EXIT_USAGE;
  }

  // Confirm step
  const skipPrompt = args.yes === true || args.json === true;
  if (!skipPrompt) {
    const isTTY = (deps.isTTY ?? ((): boolean => process.stdin.isTTY === true))();
    if (!isTTY) {
      printError(
        'inventory remove requires --yes in non-interactive mode',
        streams,
      );
      return EXIT_USAGE;
    }
    const confirmFn = deps.confirm ?? defaultConfirm;
    const proceed = await confirmFn(
      `Remove platform '${args.platformId}' and revoke its cert? [y/N]`,
    );
    if (!proceed) {
      streams.stdout('Aborted; no changes made.\n');
      return EXIT_OK;
    }
  }

  // Phase 1: revoke (atomic abort if this fails -- inventory untouched).
  try {
    await deps.caManager.revokeKeys(args.platformId);
  } catch (err) {
    // NO_CERT is special: there's no cert to revoke (e.g., platform was
    // discovered but never had a cert signed). Continue to inventory
    // removal in that case so the operator can clean up dangling entries.
    if (err instanceof CAError && err.code === 'NO_CERT') {
      // fall through to phase 2 with cert_revoked=false
      return runRemovePhase2(args, deps, streams, false);
    }
    if (args.json === true) {
      printJson(
        { ok: false, error: (err as Error).message, code: 'REVOKE_FAILED' },
        streams,
      );
    } else {
      printError(`cert revocation failed: ${(err as Error).message}`, streams);
    }
    return EXIT_USAGE;
  }

  return runRemovePhase2(args, deps, streams, true);
}

async function runRemovePhase2(
  args: InventoryRemoveArgs,
  deps: InventoryRemoveDeps,
  streams: OutputStreams,
  certRevoked: boolean,
): Promise<number> {
  // Phase 2: remove the inventory record.
  await deps.inventoryManager.removePlatform(args.platformId);

  if (args.json === true) {
    printJson(
      { removed: args.platformId, cert_revoked: certRevoked },
      streams,
    );
  } else {
    streams.stdout(
      `Removed ${args.platformId}; cert ${certRevoked ? 'revoked' : 'not revoked (no cert was on file)'}.\n` +
        `Note: the CA pubkey on the platform is NOT removed; remove it manually if desired.\n`,
    );
  }
  return EXIT_OK;
}

async function defaultConfirm(msg: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${msg} `, (a) => resolve(a));
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
