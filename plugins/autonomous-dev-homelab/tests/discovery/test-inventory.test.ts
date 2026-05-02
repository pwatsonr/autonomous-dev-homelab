/**
 * InventoryManager unit tests. Covers SPEC-001-1-03 acceptance criteria:
 * CRUD, atomic write, mutex serialization, schema-rejection of corrupt
 * files.
 */

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as yaml from 'js-yaml';
import { InventoryManager } from '../../src/discovery/inventory';
import { InventoryError, type Platform } from '../../src/discovery/inventory-types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

const ISO_NOW = '2026-05-01T00:00:00.000Z';

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: overrides.id ?? 'proxmox-ve-192-168-1-10',
    type: overrides.type ?? 'proxmox-ve',
    host: overrides.host ?? '192.168.1.10',
    port: overrides.port ?? 8006,
    discovered_at: overrides.discovered_at ?? ISO_NOW,
    last_seen: overrides.last_seen ?? ISO_NOW,
    ...overrides,
  };
}

describe('InventoryManager', () => {
  let tempDir: string;
  let inventoryPath: string;

  beforeEach(async () => {
    tempDir = await mkTempDir();
    inventoryPath = path.join(tempDir, 'inventory.yaml');
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  test('addPlatform creates the file and persists the entry', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await mgr.addPlatform(makePlatform());
    const list = await mgr.listPlatforms();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('proxmox-ve-192-168-1-10');
    // File on disk parses to the same shape.
    const raw = yaml.load(await fs.readFile(inventoryPath, 'utf8')) as {
      version: string;
      platforms: Platform[];
    };
    expect(raw.version).toBe('1.0');
    expect(raw.platforms).toHaveLength(1);
  });

  test('addPlatform rejects DUPLICATE_ID', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await mgr.addPlatform(makePlatform());
    await expect(mgr.addPlatform(makePlatform())).rejects.toMatchObject({
      code: 'DUPLICATE_ID',
    });
  });

  test('updatePlatform merges fields and bumps last_seen', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await mgr.addPlatform(makePlatform({ last_seen: '2026-01-01T00:00:00.000Z' }));
    const merged = await mgr.updatePlatform('proxmox-ve-192-168-1-10', {
      metadata: { confidence: 0.99 },
    });
    expect(merged.metadata).toEqual({ confidence: 0.99 });
    expect(merged.last_seen).not.toBe('2026-01-01T00:00:00.000Z');
  });

  test('updatePlatform NOT_FOUND', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await expect(mgr.updatePlatform('no-such-id', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('getPlatform returns null when absent', async () => {
    const mgr = new InventoryManager(inventoryPath);
    expect(await mgr.getPlatform('nope')).toBeNull();
  });

  test('listPlatforms filters by type', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await mgr.addPlatform(makePlatform({ id: 'proxmox-ve-1-1-1-1', host: '1.1.1.1' }));
    await mgr.addPlatform(
      makePlatform({ id: 'unraid-2-2-2-2', type: 'unraid', host: '2.2.2.2', port: 443 }),
    );
    expect(await mgr.listPlatforms({ type: 'proxmox-ve' })).toHaveLength(1);
    expect(await mgr.listPlatforms({ type: 'unraid' })).toHaveLength(1);
    expect(await mgr.listPlatforms()).toHaveLength(2);
  });

  test('removePlatform is idempotent (no-op when absent)', async () => {
    const mgr = new InventoryManager(inventoryPath);
    await mgr.removePlatform('nope'); // no throw
    await mgr.addPlatform(makePlatform());
    await mgr.removePlatform('proxmox-ve-192-168-1-10');
    expect(await mgr.listPlatforms()).toHaveLength(0);
  });

  test('100-concurrent-add stress test serializes through the mutex', async () => {
    const mgr = new InventoryManager(inventoryPath);
    const adds = Array.from({ length: 100 }, (_, i) =>
      mgr.addPlatform(
        makePlatform({
          id: `docker-10-0-0-${i}`,
          type: 'docker',
          host: `10.0.0.${i}`,
          port: 2375,
        }),
      ),
    );
    await Promise.all(adds);
    const list = await mgr.listPlatforms();
    expect(list).toHaveLength(100);
    // Every id must be unique.
    expect(new Set(list.map((p) => p.id)).size).toBe(100);
  }, 30_000);

  test('corrupted YAML triggers INVALID_INVENTORY', async () => {
    await fs.writeFile(inventoryPath, '{not valid yaml ::: maybe', 'utf8');
    const mgr = new InventoryManager(inventoryPath);
    await expect(mgr.listPlatforms()).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  test('schema-violating content triggers INVALID_INVENTORY', async () => {
    await fs.writeFile(
      inventoryPath,
      yaml.dump({
        version: '1.0',
        platforms: [{ id: 'BAD ID HAS SPACES', type: 'docker', host: 'x', port: 1, discovered_at: 'x', last_seen: 'x' }],
      }),
      'utf8',
    );
    const mgr = new InventoryManager(inventoryPath);
    await expect(mgr.listPlatforms()).rejects.toMatchObject({
      code: 'INVALID_INVENTORY',
    });
  });

  test('missing file returns empty inventory', async () => {
    const mgr = new InventoryManager(inventoryPath);
    expect(await mgr.listPlatforms()).toEqual([]);
  });

  test('InventoryError is an Error with stable code', () => {
    const e = new InventoryError('NOT_FOUND', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.name).toBe('InventoryError');
  });
});
