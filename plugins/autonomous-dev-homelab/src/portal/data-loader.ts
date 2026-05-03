/**
 * Reads canonical state files for the homelab portal panel.
 * SPEC-002-3-03 §"`data-loader.ts`".
 *
 * The plugin's portal panel is READ-ONLY: it only loads JSON files
 * already written by PLAN-001-1, PLAN-002-1, and PLAN-002-2 (and the
 * audit subsystem). No file is mutated through this loader.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface DataLoaderOptions {
  /** Override homelab data dir; default resolves from env. */
  dataDir?: string;
}

function resolveDataDir(override?: string): string {
  if (override !== undefined) return override;
  const fromEnv = process.env['HOMELAB_DATA_DIR'] ?? process.env['CLAUDE_PLUGIN_DATA'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.resolve(process.cwd(), '.homelab-data');
}

async function readJsonOrEmpty<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readJsonDir<T>(dirPath: string): Promise<T[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: T[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dirPath, entry), 'utf8');
      out.push(JSON.parse(raw) as T);
    } catch {
      // skip malformed files
    }
  }
  return out;
}

export interface InventoryEntry {
  id: string;
  type: string;
  hostname?: string;
  status?: string;
}

export interface ObservationRecord {
  id: string;
  platform: string;
  pattern: string;
  resource: string;
  severity: 'P0' | 'P1' | 'P2';
  discovered_at: string;
  details?: Record<string, unknown>;
}

export interface PendingActionRecord {
  id: string;
  destructiveness: string;
  description: string;
  initiatedAt: string;
}

export interface MigrationRecord {
  migration_id: string;
  source_platform: string;
  target_platform: string;
  state: string;
  updated_at: string;
}

export interface AuditRecord {
  type: string;
  reason: string;
  occurred_at: string;
  action_id?: string;
}

export class HomelabDataLoader {
  private readonly dataDir: string;

  constructor(opts: DataLoaderOptions = {}) {
    this.dataDir = resolveDataDir(opts.dataDir);
  }

  async loadInventory(): Promise<InventoryEntry[]> {
    // Inventory lives in a YAML file in production; the portal loader
    // delegates to a JSON sidecar when present (and otherwise returns
    // empty so the panel renders without crashing).
    const inv = await readJsonOrEmpty<{ platforms?: InventoryEntry[] }>(
      path.join(this.dataDir, 'inventory.json'),
      { platforms: [] },
    );
    return inv.platforms ?? [];
  }

  async loadObservations(filter: { sinceMs?: number; platform?: string; severity?: string } = {}): Promise<ObservationRecord[]> {
    const all = await readJsonDir<ObservationRecord>(path.join(this.dataDir, 'observations'));
    return all.filter((o) => {
      if (filter.platform !== undefined && o.platform !== filter.platform) return false;
      if (filter.severity !== undefined && o.severity !== filter.severity) return false;
      if (filter.sinceMs !== undefined) {
        const ts = Date.parse(o.discovered_at);
        if (!Number.isNaN(ts) && ts < filter.sinceMs) return false;
      }
      return true;
    });
  }

  async loadPendingActions(): Promise<PendingActionRecord[]> {
    const dir = path.join(this.dataDir, 'pending-actions');
    return readJsonDir<PendingActionRecord>(dir);
  }

  async loadMigrations(): Promise<MigrationRecord[]> {
    const dir = path.join(this.dataDir, 'migrations');
    return readJsonDir<MigrationRecord>(dir);
  }

  async loadAudit(filter: { sinceMs?: number } = {}): Promise<AuditRecord[]> {
    const dir = path.join(this.dataDir, 'audit');
    const all = await readJsonDir<AuditRecord>(dir);
    if (filter.sinceMs !== undefined) {
      return all.filter((a) => {
        const ts = Date.parse(a.occurred_at);
        return Number.isNaN(ts) || ts >= filter.sinceMs!;
      });
    }
    return all;
  }
}
