# SPEC-001-1-04: `discover` and `inventory list` CLI Subcommands

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 8 (`discover` subcommand), Task 9 (`inventory list` subcommand)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-1-04-discover-and-inventory-cli.md`

## Description
Wire `ConsentManager` (SPEC-001-1-01), `PlatformProber` (SPEC-001-1-02), and `InventoryManager` (SPEC-001-1-03) into two CLI subcommands of the `autonomous-dev-homelab` binary: `discover` (request consent if missing → scan → write inventory) and `inventory list` (read inventory → print). Both subcommands support a `--json` flag for structured output suitable for piping into other tools or audit logs.

This spec contains no new discovery, consent, or storage logic -- it composes existing components and handles argument parsing, exit codes, and human/JSON output formatting. Authentication for the CLI itself is reused from PRD-009 (autonomous-dev) and is out of scope here.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/cli/commands/discover.ts` | Create | `discover` command handler |
| `plugins/autonomous-dev-homelab/src/cli/commands/inventory.ts` | Create | `inventory list` command handler |
| `plugins/autonomous-dev-homelab/src/cli/index.ts` | Modify | Register both subcommands with the router |
| `plugins/autonomous-dev-homelab/src/cli/output.ts` | Create | Small helpers: `printTable`, `printJson`, `printError` |
| `plugins/autonomous-dev-homelab/src/cli/exit-codes.ts` | Create | Named exit-code constants |

## Implementation Details

### CLI Argument Surface

```
autonomous-dev-homelab discover [--cidr <cidr>] [--json] [--no-prompt]
autonomous-dev-homelab inventory list [--type <platform>] [--json]
```

`discover`:
- `--cidr <cidr>` (optional): scan only this CIDR. Without this flag, scan every CIDR present in the consent file (and unexpired with matching fingerprint).
- `--json`: emit a JSON object to stdout instead of human-readable lines. No interactive prompts permitted (use `--no-prompt`).
- `--no-prompt`: never invoke the interactive consent prompt; if consent is missing or invalid, exit with code 2 instead.

`inventory list`:
- `--type <platform>`: filter by `PlatformType` enum value.
- `--json`: emit a JSON array to stdout instead of a table.

### `discover` Behavior

```typescript
async function discover(args: {
  cidr?: string; json?: boolean; noPrompt?: boolean;
}): Promise<number> { /* returns exit code */ }
```

Algorithm:
1. Resolve `<homelab-data>` from the existing autonomous-dev config infrastructure (TDD-007 / PLAN-007-X). Construct `ConsentManager` and `InventoryManager` against `<homelab-data>/network_consent.yaml` and `<homelab-data>/inventory.yaml`.
2. Determine target CIDRs:
   - If `--cidr` provided: CIDRs = `[args.cidr]`.
   - Else: load all consents; CIDRs = consents that are unexpired AND have matching fingerprint. If empty, print "no consented CIDRs available; pass --cidr to scan a new range" and exit `EXIT_NO_CONSENT` (2).
3. For each CIDR:
   a. Call `consent = await consentManager.checkConsent(<first IP in cidr>)`. (`checkConsent` accepts an IP; we use the network address with the host bit set to 1.)
   b. If `consent` is null:
      - If `--no-prompt`: print error, increment failure counter, continue.
      - Else: call `consentManager.requestConsent(cidr, [80, 443, 2375, 2377, 6443, 8006, 8443], ['http_probe'])`. If rejected, exit `EXIT_NO_CONSENT` (2).
   c. With consent in hand, call `prober.scan(cidr, consent)`.
   d. For each match:
      - Generate a stable `id` from `${platformType}-${ip.replaceAll('.', '-')}`.
      - If `getPlatform(id)` returns existing entry, call `updatePlatform(id, { last_seen: now, metadata: { confidence: match.confidence } })`.
      - Else, call `addPlatform({ id, type: match.platformType, host: match.ip, port: match.port, discovered_at: now, last_seen: now, metadata: { confidence: match.confidence, protocol: match.protocol } })`.
4. Output:
   - Human mode: print one line per match: `<type> @ <host>:<port> (confidence: X.XX) [new|updated]`. Print summary: `Discovered N platforms (M new, K updated) across X CIDRs.`
   - JSON mode: emit `{ "scanned_cidrs": [...], "matches": [<MatchedPlatform>...], "added_ids": [...], "updated_ids": [...] }` to stdout, single line.
5. Return `EXIT_OK` (0) if at least one CIDR scanned successfully (even if zero matches). Return `EXIT_PARTIAL` (3) if some CIDRs failed.

### `inventory list` Behavior

```typescript
async function inventoryList(args: { type?: PlatformType; json?: boolean }): Promise<number>;
```

Algorithm:
1. Construct `InventoryManager` against `<homelab-data>/inventory.yaml`.
2. Call `listPlatforms(args.type ? { type: args.type } : undefined)`.
3. Output:
   - Human mode (default): print a table with columns `ID`, `TYPE`, `HOST:PORT`, `LAST_SEEN`. Empty inventory prints "no platforms discovered yet; run `discover --cidr <cidr>` to scan."
   - JSON mode: emit the array of `Platform` objects, single line.
4. Return `EXIT_OK` (0).

### Output Helpers (`output.ts`)

```typescript
export function printTable(rows: Record<string, string>[], columns: string[]): void;  // simple fixed-width
export function printJson(value: unknown): void;                                      // JSON.stringify, single line, to stdout
export function printError(msg: string): void;                                        // to stderr, prefixed "ERROR: "
```

### Exit Codes (`exit-codes.ts`)

```typescript
export const EXIT_OK         = 0;
export const EXIT_USAGE      = 1;     // bad CLI args
export const EXIT_NO_CONSENT = 2;     // missing/rejected consent
export const EXIT_PARTIAL    = 3;     // some CIDRs scanned, some failed
export const EXIT_INTERNAL   = 10;    // unexpected internal error
```

### Argument Parsing

Use the existing CLI router from autonomous-dev (the homelab plugin reuses it). If no shared router exists, hand-roll with `process.argv` slicing -- no third-party arg-parse library. Reject unknown flags with `EXIT_USAGE`.

### `discover --no-prompt` and `--json` Combination

`--json` MUST imply `--no-prompt` (interactive prompts and JSON output are mutually exclusive). If the operator passes only `--json`, the CLI behaves as if `--no-prompt` was also passed.

## Acceptance Criteria

- [ ] `autonomous-dev-homelab discover --cidr 192.168.1.0/24` with no existing consent invokes the interactive prompt and, on approval, scans and writes inventory. Exit code 0.
- [ ] `autonomous-dev-homelab discover --cidr 192.168.1.0/24 --no-prompt` with no existing consent prints "ERROR: no consent for 192.168.1.0/24; rerun without --no-prompt to approve" to stderr. Exit code 2.
- [ ] `autonomous-dev-homelab discover --cidr 192.168.1.0/24` with consent already in place skips the prompt and scans immediately.
- [ ] `discover --cidr` with a malformed CIDR exits with code 1 and prints a usage error.
- [ ] `discover` (no `--cidr`) with an empty consent file prints "no consented CIDRs..." to stderr and exits 2.
- [ ] `discover --json` emits a single-line JSON object to stdout containing `scanned_cidrs`, `matches`, `added_ids`, `updated_ids`. No human text on stdout.
- [ ] `discover --json` does NOT prompt interactively even if consent is missing (it behaves as `--no-prompt`).
- [ ] `discover` re-discovering a known platform calls `updatePlatform` (NOT `addPlatform`) and the discovered entry's `last_seen` advances.
- [ ] `inventory list` on an empty inventory prints "no platforms discovered yet..." and exits 0.
- [ ] `inventory list` with one platform prints a table whose header row contains `ID`, `TYPE`, `HOST:PORT`, `LAST_SEEN`.
- [ ] `inventory list --type proxmox-ve` returns only proxmox-ve entries.
- [ ] `inventory list --type k3s` (invalid enum) exits with code 1 and prints a usage error.
- [ ] `inventory list --json` emits a single-line JSON array to stdout, each element a Platform object matching the schema in SPEC-001-1-03.
- [ ] All error messages go to stderr; all data output goes to stdout. (Verified by capturing both streams in tests.)
- [ ] An unknown subcommand or unknown flag prints usage and exits 1.
- [ ] Unhandled exceptions inside `discover`/`inventory list` are caught at the top level, logged with their message + stack to stderr, and exit code 10.
- [ ] Registered subcommands appear in `autonomous-dev-homelab --help` output.

## Dependencies

- Internal: SPEC-001-1-01 (`ConsentManager`), SPEC-001-1-02 (`PlatformProber`, `MatchedPlatform`), SPEC-001-1-03 (`InventoryManager`, `Platform`).
- External: TDD-007 / PLAN-007-X autonomous-dev config infrastructure for `<homelab-data>` resolution. The CLI router (existing in autonomous-dev plugin).
- Tests: same test runner as siblings; use mocked `ConsentManager`/`PlatformProber`/`InventoryManager` to exercise CLI behavior without real I/O.

## Notes

- The default ports passed to `requestConsent` (`[80, 443, 2375, 2377, 6443, 8006, 8443]`) are the union of all `probe.port` values from SPEC-001-1-02's catalog. If the catalog grows, this list MUST be regenerated -- consider exporting `getDefaultPermittedPorts()` from SPEC-001-1-02's catalog module to keep them in sync. Out of scope to wire that helper now; document the tight coupling.
- `id` generation as `<type>-<ip-with-dashes>` (e.g., `proxmox-ve-192-168-1-10`) is deterministic and human-readable. Operators who rename a platform or move it between IPs end up with stale entries; that's an `inventory remove` concern (PLAN-001-3).
- The `printTable` helper is intentionally simple (fixed-width ASCII). Pretty rendering with libraries like `cli-table` is out of scope; the table just needs to be readable.
- `EXIT_PARTIAL` (3) handles the multi-CIDR case where one consent is valid and another is expired. This communicates "do something" to scripted callers without misleading them with exit 0 (full success) or exit 1 (full failure).
- We do NOT add `discover --dry-run` in v1; operators wanting to preview can use `--json` and inspect output before re-running. Add in v1.1 if requested.
- This spec is the smallest of the five; review attention should focus on output shape (especially JSON contracts), exit code semantics, and that the prompt/no-prompt/json combinations don't accidentally hang or write incorrect data.
