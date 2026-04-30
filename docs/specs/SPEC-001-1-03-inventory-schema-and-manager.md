# SPEC-001-1-03: Inventory Schema + InventoryManager with Atomic Writes

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 6 (inventory-v1.json schema), Task 7 (InventoryManager with atomic writes + concurrency)
- **Estimated effort**: 4.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-1-03-inventory-schema-and-manager.md`

## Description
Deliver the persistent inventory layer per TDD §7: a JSON Schema for `<homelab-data>/inventory.yaml` and an `InventoryManager` class providing CRUD over the discovered-platforms list with atomic writes and per-file mutex serialization. The inventory is the system-of-record for "what platforms exist in this homelab"; downstream plans (PLAN-001-2 connection, PLAN-002-* observation) read it to route SSH/MCP traffic and target probes.

This spec contains no discovery logic, no consent logic, no CLI -- only the schema and the manager. The manager is consumed by SPEC-001-1-04 (CLI) and by PlatformProber callers (typically the `discover` command, which writes new matches via `addPlatform`).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/schemas/inventory-v1.json` | Create | JSON Schema (draft-07) for the inventory file |
| `plugins/autonomous-dev-homelab/src/discovery/inventory.ts` | Create | `InventoryManager` class |
| `plugins/autonomous-dev-homelab/src/discovery/inventory-types.ts` | Create | TypeScript types for `Platform`, `Connection`, etc. |
| `plugins/autonomous-dev-homelab/src/util/atomic-write.ts` | Create | Reusable atomic-write helper (temp + fsync + rename) |
| `plugins/autonomous-dev-homelab/src/util/file-mutex.ts` | Create | In-process per-path mutex |
| `plugins/autonomous-dev-homelab/tests/fixtures/inventory/valid.yaml` | Create | TDD §7 example used by schema tests |

## Implementation Details

### `inventory-v1.json` Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://autonomous-dev/schemas/inventory-v1.json",
  "type": "object",
  "required": ["version", "platforms"],
  "properties": {
    "version": { "const": "1.0" },
    "platforms": {
      "type": "array",
      "items": { "$ref": "#/definitions/platform" }
    }
  },
  "additionalProperties": false,
  "definitions": {
    "platform": {
      "type": "object",
      "required": ["id", "type", "host", "port", "discovered_at", "last_seen"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$" },
        "type": {
          "type": "string",
          "enum": ["unraid", "proxmox-ve", "docker", "kubernetes", "docker-swarm", "unifi", "truenas"]
        },
        "host": { "type": "string" },
        "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
        "ssh_host": { "type": "string" },
        "ssh_port": { "type": "integer", "minimum": 1, "maximum": 65535 },
        "discovered_at": { "type": "string", "format": "date-time" },
        "last_seen": { "type": "string", "format": "date-time" },
        "metadata": { "type": "object", "additionalProperties": true },
        "connection": {
          "type": "object",
          "properties": {
            "ssh_cert_path": { "type": "string" },
            "mcp_endpoint": { "type": "string" }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": false
    }
  }
}
```

### Type Definitions (`inventory-types.ts`)

```typescript
export type PlatformType =
  | 'unraid' | 'proxmox-ve' | 'docker' | 'kubernetes'
  | 'docker-swarm' | 'unifi' | 'truenas';

export interface Connection {
  ssh_cert_path?: string;
  mcp_endpoint?: string;
  [key: string]: unknown;              // forward-compat
}

export interface Platform {
  id: string;                          // [a-z0-9][a-z0-9-]{0,62}
  type: PlatformType;
  host: string;                        // IP or DNS name
  port: number;
  ssh_host?: string;
  ssh_port?: number;
  discovered_at: string;               // ISO-8601
  last_seen: string;                   // ISO-8601
  metadata?: Record<string, unknown>;
  connection?: Connection;
}

export interface InventoryFile {
  version: '1.0';
  platforms: Platform[];
}
```

### `InventoryManager` API

```typescript
export class InventoryManager {
  constructor(inventoryFilePath: string);

  /** Inserts a new platform. Throws { code: 'DUPLICATE_ID' } if `platform.id` already exists. */
  async addPlatform(platform: Platform): Promise<void>;

  /** Merges `update` into the platform with matching `id`. Fields not in `update` are preserved.
   *  `last_seen` is auto-set to current time UNLESS the caller passes it explicitly.
   *  Throws { code: 'NOT_FOUND' } if no platform with that id exists. */
  async updatePlatform(id: string, update: Partial<Omit<Platform, 'id'>>): Promise<Platform>;

  /** Returns the platform or null. */
  async getPlatform(id: string): Promise<Platform | null>;

  /** Returns all platforms; optional filter by type. */
  async listPlatforms(opts?: { type?: PlatformType }): Promise<Platform[]>;

  /** Removes the matching platform. No-op if absent. */
  async removePlatform(id: string): Promise<void>;
}
```

Behavioral rules:
- Every mutation MUST go through the per-file mutex. Concurrent `addPlatform` calls from the same process serialize.
- Every write MUST use the atomic-write helper: create `<file>.tmp.<pid>.<random>`, write contents, `fsync`, `rename` over the destination. If the rename fails, the temp file MUST be removed.
- Reads do NOT take the mutex (they take a brief read lock under Node's single-threaded event loop just by reading + parsing without yielding). If the file is missing, reads return `{ version: '1.0', platforms: [] }` and writes create it.
- YAML loading MUST use `js-yaml` safe loader.
- The manager MUST validate the file against the schema on every read; corruption raises `{ code: 'INVALID_INVENTORY' }`.
- `addPlatform`'s `discovered_at` and `last_seen` MUST default to the current ISO-8601 timestamp if absent on the input object.
- `id` collisions are rejected; the caller (typically the discover command) decides how to deduplicate (by host:port, by SSH key, etc.).

### Atomic Write Helper (`atomic-write.ts`)

```typescript
/** Writes `contents` to `targetPath` atomically:
 *  1. open `${targetPath}.tmp.${pid}.${rand}` with O_WRONLY|O_CREAT|O_EXCL
 *  2. write all bytes
 *  3. fsync
 *  4. close
 *  5. rename onto targetPath
 *  6. fsync the parent directory (so the rename is durable)
 *  Throws if any step fails; cleans up the temp file on failure. */
export async function atomicWriteFile(targetPath: string, contents: string | Uint8Array): Promise<void>;
```

### File Mutex (`file-mutex.ts`)

```typescript
/** Per-path mutex backed by a Map<path, Promise<void>>. Calls to `acquire(path)`
 *  return a release function; subsequent `acquire(path)` on the same path waits. */
export function fileMutex(): {
  acquire(path: string): Promise<() => void>;
};
```

In-process only. Cross-process serialization is out of scope (see SPEC-001-1-01 Notes).

## Acceptance Criteria

- [ ] `inventory-v1.json` validates `tests/fixtures/inventory/valid.yaml` (TDD §7 example).
- [ ] Schema rejects a platform with missing `id`.
- [ ] Schema rejects `id: "Has-Caps"` (regex disallows uppercase).
- [ ] Schema rejects `type: "k3s"` (not in enum).
- [ ] Schema accepts a platform with no `metadata`, `ssh_host`, `ssh_port`, or `connection` (all optional).
- [ ] Schema rejects `port: 0` and `port: 65536`.
- [ ] `addPlatform({ id: 'unraid-01', type: 'unraid', host: '192.168.1.10', port: 443 })` (with timestamps auto-filled) writes the file with one entry; `getPlatform('unraid-01')` returns it.
- [ ] `addPlatform` with a duplicate `id` throws `{ code: 'DUPLICATE_ID' }` and does NOT mutate the file.
- [ ] `updatePlatform('unraid-01', { last_seen: '2026-01-01T00:00:00Z' })` updates `last_seen` and preserves `host`, `port`, `discovered_at`, etc.
- [ ] `updatePlatform('unraid-01', { metadata: { uptime: 3600 } })` sets metadata; `host` and `port` are unchanged.
- [ ] `updatePlatform` on a missing id throws `{ code: 'NOT_FOUND' }`.
- [ ] `getPlatform('does-not-exist')` returns `null`.
- [ ] `listPlatforms()` returns all entries; `listPlatforms({ type: 'proxmox-ve' })` filters correctly.
- [ ] `removePlatform('unraid-01')` removes the entry; subsequent `getPlatform` returns null.
- [ ] `removePlatform` on a missing id is a no-op (does NOT throw, does NOT rewrite the file).
- [ ] Reading from a missing inventory file returns an empty list (no error).
- [ ] Reading a corrupted YAML file (e.g., `{ version: 'wrong', platforms: 'not-an-array' }`) throws `{ code: 'INVALID_INVENTORY' }`.
- [ ] 100 concurrent `addPlatform` calls (each with a unique id) all succeed and the resulting file contains 100 entries (verified by counting; no interleaving).
- [ ] Atomic write: simulating a crash between write and rename (by using a fake fs that throws on `rename`) leaves the original file unchanged AND removes the temp file.
- [ ] The temp file name pattern is `<path>.tmp.<pid>.<random>` (verified by inspecting fs calls in a test).
- [ ] YAML loader is the safe one -- a fixture with `!!js/function` does NOT execute / load fails cleanly.

## Dependencies

- External: `js-yaml`, `ajv` (for schema validation in tests), Node `fs/promises`.
- Internal: None at runtime. Consumed by SPEC-001-1-04 (CLI) and downstream PLAN-001-2 (connection layer).

## Notes

- The schema's `id` regex (`^[a-z0-9][a-z0-9-]{0,62}$`) is DNS-label-shaped to permit safe use in URLs, filenames, and YAML keys downstream. 63 chars is the DNS-label max.
- `ssh_host` defaults to `host` when absent (consumer responsibility, not the manager's). The connection layer (PLAN-001-2) implements that fallback.
- `connection` is intentionally loose (`additionalProperties: true`) because PLAN-001-2 is still designing its shape. The schema can tighten in v1.1 once `Connection` stabilizes.
- The mutex strategy assumes one daemon process per host; multi-process serialization (e.g., file-locking with `flock`) is deferred. Risk register documents this.
- No journaling or transaction log -- the file is small (<1MB even for 100 platforms) and atomic rename is sufficient. If the inventory grows >10k entries (unusual for a homelab), revisit.
- `removePlatform` being idempotent simplifies CLI workflows ("remove this thing if present") and matches POSIX `rm -f` semantics.
- This spec deliberately avoids any "auto-update last_seen on read" magic. `last_seen` updates only when a caller explicitly invokes `updatePlatform`. This keeps reads side-effect-free, which matters for SPEC-001-1-04's `inventory list` command.
