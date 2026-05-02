/**
 * `autonomous-dev-homelab inventory list` command handler. Implements
 * SPEC-001-1-04 §"`inventory list` Behavior".
 *
 * Read-only: composes InventoryManager (SPEC-001-1-03) and prints either
 * a fixed-width table or a single-line JSON array.
 */

import { InventoryManager } from '../../discovery/inventory.js';
import type { Platform, PlatformType } from '../../discovery/inventory-types.js';
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
