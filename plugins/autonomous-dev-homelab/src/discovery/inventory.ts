/**
 * InventoryManager: CRUD over the discovered-platforms list with atomic
 * writes and per-file mutex serialization.
 *
 * Implements SPEC-001-1-03 / TDD-001 §7.
 *
 * Behavioral guarantees:
 * - Every mutation goes through the per-file mutex. Concurrent
 *   `addPlatform` calls from the same process serialize.
 * - Every write uses the atomic-write helper (temp + fsync + rename).
 * - Reads of a missing file return an empty inventory. Writes create it.
 * - Every read validates against `inventory-v1.json`. Corruption raises
 *   `InventoryError('INVALID_INVENTORY')`.
 * - YAML loading uses js-yaml's safe `load` (no `!!js/function` execution).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteFile } from '../util/atomic-write.js';
import { fileMutex, type FileMutex } from '../util/file-mutex.js';
import {
  InventoryError,
  type InventoryFile,
  type Platform,
  type PlatformType,
} from './inventory-types.js';

// Schema bundled at build time so the manager works regardless of cwd.
// Using a require() resolved relative to this file keeps the runtime
// loader simple and avoids depending on import.meta.url under CommonJS.
import schemaJson from '../../schemas/inventory-v1.json';

const SHARED_MUTEX: FileMutex = fileMutex();
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateInventory: ValidateFunction = ajv.compile(schemaJson);

export class InventoryManager {
  private readonly inventoryFilePath: string;
  private readonly mutex: FileMutex;

  constructor(inventoryFilePath: string, opts: { mutex?: FileMutex } = {}) {
    this.inventoryFilePath = path.resolve(inventoryFilePath);
    this.mutex = opts.mutex ?? SHARED_MUTEX;
  }

  /** Inserts a new platform. Throws DUPLICATE_ID if `platform.id` already exists. */
  async addPlatform(input: Platform): Promise<void> {
    const release = await this.mutex.acquire(this.inventoryFilePath);
    try {
      const file = await this.readFile();
      if (file.platforms.some((p) => p.id === input.id)) {
        throw new InventoryError('DUPLICATE_ID', `platform id already exists: ${input.id}`);
      }
      const now = new Date().toISOString();
      const platform: Platform = {
        ...input,
        discovered_at: input.discovered_at ?? now,
        last_seen: input.last_seen ?? now,
      };
      file.platforms.push(platform);
      await this.writeFile(file);
    } finally {
      release();
    }
  }

  /**
   * Merges `update` into the platform with matching `id`. Auto-sets
   * `last_seen` to the current time unless the caller passes it.
   * Throws NOT_FOUND if no platform with that id exists.
   */
  async updatePlatform(id: string, update: Partial<Omit<Platform, 'id'>>): Promise<Platform> {
    const release = await this.mutex.acquire(this.inventoryFilePath);
    try {
      const file = await this.readFile();
      const idx = file.platforms.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new InventoryError('NOT_FOUND', `platform not found: ${id}`);
      }
      const existing = file.platforms[idx]!;
      const lastSeen = update.last_seen ?? new Date().toISOString();
      const merged: Platform = {
        ...existing,
        ...update,
        id: existing.id,
        last_seen: lastSeen,
      };
      file.platforms[idx] = merged;
      await this.writeFile(file);
      return merged;
    } finally {
      release();
    }
  }

  async getPlatform(id: string): Promise<Platform | null> {
    const file = await this.readFile();
    return file.platforms.find((p) => p.id === id) ?? null;
  }

  async listPlatforms(opts: { type?: PlatformType } = {}): Promise<Platform[]> {
    const file = await this.readFile();
    if (opts.type === undefined) return [...file.platforms];
    return file.platforms.filter((p) => p.type === opts.type);
  }

  /** Removes the matching platform. No-op (no file rewrite) if absent. */
  async removePlatform(id: string): Promise<void> {
    const release = await this.mutex.acquire(this.inventoryFilePath);
    try {
      const file = await this.readFile();
      const idx = file.platforms.findIndex((p) => p.id === id);
      if (idx < 0) return; // idempotent: no rewrite if absent
      file.platforms.splice(idx, 1);
      await this.writeFile(file);
    } finally {
      release();
    }
  }

  // --- internals ---------------------------------------------------------

  private async readFile(): Promise<InventoryFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.inventoryFilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: '1.0', platforms: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new InventoryError(
        'INVALID_INVENTORY',
        `failed to parse inventory YAML: ${(err as Error).message}`,
      );
    }
    if (parsed === null || parsed === undefined) {
      return { version: '1.0', platforms: [] };
    }
    if (!validateInventory(parsed)) {
      const errs = (validateInventory.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
      throw new InventoryError('INVALID_INVENTORY', `inventory failed schema validation: ${errs}`);
    }
    const file = parsed as InventoryFile;
    return { version: file.version, platforms: [...file.platforms] };
  }

  private async writeFile(file: InventoryFile): Promise<void> {
    if (!validateInventory(file)) {
      const errs = (validateInventory.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
      throw new InventoryError('INVALID_INVENTORY', `refusing to write invalid inventory: ${errs}`);
    }
    const serialized = yaml.dump(file, { noRefs: true, sortKeys: false });
    await atomicWriteFile(this.inventoryFilePath, serialized);
  }
}
