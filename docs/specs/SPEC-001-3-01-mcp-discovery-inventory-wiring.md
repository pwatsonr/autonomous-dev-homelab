# SPEC-001-3-01: MCPDiscovery + Inventory Wiring

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 1 (implement `MCPDiscovery`), Task 2 (wire MCP discovery into inventory updates)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-3-01-mcp-discovery-inventory-wiring.md`

## Description
Implement `MCPDiscovery` per TDD-001 §10: at startup, parse the operator's `~/.config/claude/.mcp.json`, identify entries whose name matches the homelab platform list (`mcp-server-{proxmox,kubernetes,docker,unraid,unifi,truenas}`), and expose them as a typed list of available MCP servers. Then wire the discovery output into the existing `discover` CLI command so that each newly-inventoried platform's `connection.mcp_endpoint` is populated when (and only when) the matching mcp-server is installed.

This spec is the connective tissue between operator-installed MCP servers and the homelab inventory: it does not install MCP servers (assumed already present), and it does not change the MCP servers' behavior — it only enumerates them and wires the result into one inventory field per platform. The opt-out env var `HOMELAB_DISABLE_MCP_DISCOVERY=1` short-circuits the discovery and yields an empty list.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/connection/mcp-discovery.ts` | Create | `MCPDiscovery` class + `MCPServerInfo` type |
| `plugins/autonomous-dev-homelab/src/cli/commands/discover.ts` | Modify | Inject `MCPDiscovery`, populate `connection.mcp_endpoint` per discovered platform |
| `plugins/autonomous-dev-homelab/tests/connection/test-mcp-discovery.test.ts` | Create | Unit tests with `.mcp.json` fixtures |
| `plugins/autonomous-dev-homelab/tests/cli/test-discover-mcp-wiring.test.ts` | Create | Verifies inventory entries get correct `mcp_endpoint` |
| `plugins/autonomous-dev-homelab/tests/fixtures/mcp/mcp-with-proxmox-and-k8s.json` | Create | Fixture: `.mcp.json` with two relevant servers |
| `plugins/autonomous-dev-homelab/tests/fixtures/mcp/mcp-empty.json` | Create | Fixture: `.mcp.json` with no homelab servers |

## Implementation Details

### `MCPServerInfo` Type

```typescript
export interface MCPServerInfo {
  /** e.g. "mcp-server-proxmox" */
  name: string;
  /** e.g. "proxmox" — derived from name suffix */
  platform: HomelabPlatformId;
  /** Full command line as declared in .mcp.json (for debug/audit). */
  command: string;
}

export type HomelabPlatformId =
  | 'proxmox' | 'kubernetes' | 'docker'
  | 'unraid' | 'unifi' | 'truenas';
```

### `MCPDiscovery` Class

```typescript
export class MCPDiscovery {
  constructor(
    private readonly mcpConfigPath: string = path.join(
      os.homedir(), '.config', 'claude', '.mcp.json'
    ),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Returns the list of installed mcp-server-* matching homelab platforms. */
  async discover(): Promise<MCPServerInfo[]> { /* ... */ }

  /** Returns the MCPServerInfo for a given platform, or null. */
  async getForPlatform(platform: HomelabPlatformId): Promise<MCPServerInfo | null> { /* ... */ }
}
```

Behavior:
1. If `env.HOMELAB_DISABLE_MCP_DISCOVERY === '1'`, return `[]` immediately. Log at debug level: `MCP discovery disabled by env var`.
2. If `mcpConfigPath` does not exist, return `[]`. Log at debug level: `No .mcp.json found at <path>`.
3. Read the file. If JSON parse fails, log a warning (`Malformed .mcp.json; ignoring`) and return `[]`. Do not throw — discovery is best-effort.
4. Iterate the `mcpServers` object. For each entry whose **key** matches `^mcp-server-(proxmox|kubernetes|docker|unraid|unifi|truenas)$`, build an `MCPServerInfo` with the suffix as `platform` and the entry's `command` field (joined with args if it's an array).
5. Return the list, sorted by `platform` (deterministic for tests).

### Inventory Wiring

Modify `src/cli/commands/discover.ts`:
- Inject `MCPDiscovery` (constructor or factory; do not instantiate inline — must be mockable in tests).
- After `NetworkScanner` produces a list of candidate platforms with their fingerprinted `platform` field, call `mcpDiscovery.discover()` once to get the full list.
- Build a `Map<HomelabPlatformId, string>` from `platform → mcp-server-name`.
- For each new platform inventory entry, set `connection.mcp_endpoint = map.get(entry.platform) ?? null`.
- Existing inventory entries (already in `inventory.yaml`) are not modified by `discover` (separate command updates).

### Audit Hook (deferred)

This spec does NOT emit audit-log entries for discovery. SPEC-001-3-02 introduces the audit writer and wires `discovery_started` / `discovery_completed` events. The `discover` command will be re-touched there.

### Edge Cases the Implementer Must Handle

1. **`.mcp.json` missing the top-level `mcpServers` object**: Treat as empty (no servers). Do not throw.
2. **An entry whose key matches but whose `command` field is missing or empty**: Skip the entry; log a warning naming the malformed key. Other entries proceed normally.
3. **An entry whose `command` is an array of strings**: Join with spaces (preserving order) into a single `command` string on `MCPServerInfo`.
4. **Symlinked `~/.config/claude` directory**: Resolve via `fs.realpath` once; do not re-resolve on every call.
5. **Permission denied reading the file** (e.g., operator's home dir is over-restricted): Log a warning, return `[]`. Discovery is best-effort and must never block the `discover` command.
6. **The `mcp_endpoint` field already exists on the inventory entry from a prior run**: Overwrite if MCP is now present; set to `null` if no longer present (operator uninstalled the MCP server). This makes `discover` idempotent.

### Logging

`MCPDiscovery` uses the homelab plugin's existing logger (matches the pattern in `discover.ts`). Levels:
- `debug` — opt-out hit, file missing, file empty.
- `warn` — malformed JSON, malformed individual entry, permission denied.
- `info` — discovery completed (`Discovered 2 MCP server(s) for homelab platforms: kubernetes, proxmox`).

Never `error` — the absence of MCP servers is a normal operating state, not an error.

## Acceptance Criteria

- [ ] `MCPDiscovery.discover()` returns `[]` when `~/.config/claude/.mcp.json` does not exist.
- [ ] `MCPDiscovery.discover()` returns `[]` when `HOMELAB_DISABLE_MCP_DISCOVERY=1`.
- [ ] `MCPDiscovery.discover()` returns `[]` (and logs a warning) when `.mcp.json` is malformed JSON.
- [ ] Given fixture `mcp-with-proxmox-and-k8s.json` (containing `mcp-server-proxmox` and `mcp-server-kubernetes`), `discover()` returns exactly two `MCPServerInfo` objects, sorted with `kubernetes` before `proxmox`.
- [ ] `mcp-server-foo` (not in the homelab platform list) is filtered out.
- [ ] `MCPServerInfo.platform` is the correct enum value (e.g., `"proxmox"` not `"mcp-server-proxmox"`).
- [ ] `MCPDiscovery.getForPlatform('proxmox')` returns the matching entry or `null`.
- [ ] After running `discover`, an inventoried Proxmox platform has `connection.mcp_endpoint === "mcp-server-proxmox"` when the MCP server is in `.mcp.json`.
- [ ] After running `discover` with no MCP servers installed, every new inventory entry has `connection.mcp_endpoint === null`.
- [ ] `MCPDiscovery` is injected (constructor parameter or factory), allowing tests to use a custom config path and mocked env.
- [ ] Unit test coverage on `mcp-discovery.ts` ≥ 95%.
- [ ] No regressions in existing `discover.ts` tests (PLAN-001-1).
- [ ] Re-running `discover` after the operator uninstalls an MCP server clears the inventory's `mcp_endpoint` back to `null` (idempotency).
- [ ] An `.mcp.json` missing the `mcpServers` top-level object yields `[]` without throwing.
- [ ] An entry whose `command` is an array (e.g., `["node", "/path/to/server.js"]`) yields a joined command string on `MCPServerInfo`.

## Dependencies

- **Blocked by**: PLAN-001-1 (provides `discover` command, `InventoryManager`, `inventory.yaml` schema with `connection.mcp_endpoint` field).
- **Consumed by**: PLAN-001-2's connection auto-selection logic (knows whether MCP is available before attempting transport).
- Node.js `fs/promises`, `path`, `os` (standard library only).

## Notes

- `MCPDiscovery` is intentionally read-only and stateless; each `discover()` call re-parses `.mcp.json`. If profiling shows this is hot, add a TTL cache later — for MVP, simplicity wins.
- The opt-out env var is documented in the operator guide as a privacy feature: operators concerned about the homelab plugin reading their MCP config can disable discovery and lose only the auto-selection convenience (they can still use SSH transport).
- Future enhancement (out of scope here): observe `.mcp.json` for changes via `fs.watch` and refresh the cached list. Today, an operator who installs a new mcp-server must re-run `discover` for it to be reflected in inventory.
- The discovery is **per-platform**, not per-host — if the operator installs `mcp-server-proxmox`, it applies to every inventoried Proxmox host. Multi-host MCP routing is out of scope.
