# SPEC-001-3-05: Unit Tests + Full Operator Workflow Integration Test

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 11 (unit tests for audit log + MCP discovery), Task 12 (integration test for full operator workflow)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-3-05-unit-and-integration-tests.md`

## Description
Two test suites that close out PLAN-001-3. First, unit-test files for the two new modules (`audit/writer.ts` from SPEC-001-3-02, `connection/mcp-discovery.ts` from SPEC-001-3-01) targeting ≥95% line and branch coverage. Second, an end-to-end integration test that runs the full operator workflow (`consent grant` → `discover` → `ca init` → `platform install-ca` → `platform connect-test` → `audit verify`), asserting each step succeeds in order and the audit log shows the expected event sequence.

The integration test runs against fixtures and mocks (no real network, no real SSH/HTTP), so it must be deterministic in CI: same inputs → identical audit log byte-for-byte (modulo timestamps, which are pinned via `Date.now` injection).

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/audit/test-writer.test.ts` | Create | Unit tests for `AuditWriter` and `AuditKeyStore` |
| `plugins/autonomous-dev-homelab/tests/connection/test-mcp-discovery.test.ts` | Create | Unit tests for `MCPDiscovery` (overlap with SPEC-001-3-01's per-spec test; this is the canonical, comprehensive version) |
| `plugins/autonomous-dev-homelab/tests/integration/test-operator-workflow.test.ts` | Create | End-to-end workflow with all major commands |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/inventory-empty.yaml` | Create | Starting inventory: empty |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/scan-response-proxmox.json` | Create | Mocked nmap+probe response: 1 Proxmox host |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/proxmox-api-mock.ts` | Create | HTTP mock: Proxmox API endpoints used during install-ca + connect-test |
| `plugins/autonomous-dev-homelab/tests/integration/fixtures/ssh-mock.ts` | Create | SSH transport mock: returns canned `whoami` response |
| `plugins/autonomous-dev-homelab/tests/utils/clock.ts` | Create | Injectable clock for deterministic timestamps |

## Implementation Details

### `test-writer.test.ts` (Unit)

Coverage targets `audit/writer.ts` and `audit/key-store.ts`. Test groups:

**`AuditKeyStore`:**
- Generates a 32-byte (64 hex char + newline) key on first call when file is absent.
- Persists with mode `0600` (verify via `fs.statSync`).
- Reads existing key on subsequent calls (does not regenerate).
- If file mode is wrong (e.g., `0644`), logs a warning but still uses the key.
- If file is corrupt (not 64 hex chars), throws `InvalidAuditKeyError`.

**`AuditWriter` — basic:**
- Empty log: first append produces `seq: 1`, `prev_hmac` input is `'0'.repeat(64)`.
- Subsequent appends produce monotonic seq, each chained from the prior HMAC.
- Canonical JSON: keys sorted alphabetically, no whitespace (verify by hashing two equivalent payloads in different key orders → identical HMAC).
- HMAC computed against `key`, `prev_hmac || canonical_json_of_entry_minus_hmac`.

**`AuditWriter` — concurrency:**
- 1000 concurrent `append` calls produce 1000 lines, all parse cleanly, seq is contiguous 1..1000, every HMAC verifies against the prior.
- `pendingWrites()` reports queue depth during burst.

**`AuditWriter` — recovery:**
- After process restart (new instance with same `logPath`), `getLastHmac` returns the HMAC of the final line by tail-reading the last 4 KiB.
- If the log's last line is truncated (no trailing newline), recovery throws `CorruptAuditLogError` rather than silently dropping data.
- If the log file is missing (deleted between runs), `getLastHmac` returns the zero-string and the next append starts at seq 1.

**`AuditWriter` — error handling:**
- Disk full / permission denied during `appendFile` propagates as `AuditWriteError` to the caller. Mutex is released. Subsequent appends succeed once disk recovers.
- Caller-supplied payload is not mutated.

Coverage assertion: `npm run test:coverage -- audit/` shows ≥95% lines and ≥95% branches on both files. CI fails the spec if below.

### `test-mcp-discovery.test.ts` (Unit)

Coverage targets `connection/mcp-discovery.ts`. Test groups:

- `discover()` returns `[]` when `~/.config/claude/.mcp.json` does not exist (use a temp dir as the configured path).
- `discover()` returns `[]` and logs a warning when the file is malformed JSON.
- `discover()` returns `[]` when `HOMELAB_DISABLE_MCP_DISCOVERY=1` (test injects env).
- Given fixture `mcp-with-proxmox-and-k8s.json`, returns exactly two entries with correct `platform` and `name` fields, sorted by platform.
- Filters out `mcp-server-foo` (not a homelab platform).
- Filters out `mcp-server-Proxmox` (case-sensitive — only lowercase matches).
- `MCPServerInfo.command` is correctly assembled when the entry's `command` is an array vs string.
- `getForPlatform('proxmox')` returns the matching entry; returns `null` when not present.

Coverage assertion: ≥95% lines and ≥95% branches on `mcp-discovery.ts`.

### `test-operator-workflow.test.ts` (Integration)

End-to-end test simulating a fresh operator setup. Steps run in this order; each must succeed before the next.

```typescript
describe('full operator workflow', () => {
  let tmpHomelabData: string;
  let auditWriter: AuditWriter;
  let cli: HomelabCLI;

  beforeAll(async () => {
    tmpHomelabData = await mkdtemp('/tmp/homelab-it-');
    setClockFixed('2026-04-29T10:00:00.000Z');
    mockProxmoxAPI(tmpHomelabData);
    mockSSH({ whoami: 'root\n' });
    cli = await buildCLI({ homelabData: tmpHomelabData });
  });

  it('grants consent for the lab subnet', async () => {
    const exit = await cli.run([
      'consent', 'grant', '192.168.1.0/24',
      '--ports', '22,8006', '--scan-types', 'tcp',
      '--json',
    ]);
    expect(exit).toBe(0);
  });

  it('discovers one Proxmox host', async () => {
    const exit = await cli.run(['discover', '--json']);
    expect(exit).toBe(0);
    const inv = await readInventory(tmpHomelabData);
    expect(inv.platforms).toHaveLength(1);
    expect(inv.platforms[0].platform).toBe('proxmox');
  });

  it('initializes the CA', async () => {
    const exit = await cli.run([
      'ca', 'init',
      '--passphrase-file', '/dev/null',  // Test mode: empty passphrase.
      '--json',
    ], { actor: 'admin-user' });
    expect(exit).toBe(0);
  });

  it('installs the CA on the Proxmox host', async () => {
    const exit = await cli.run([
      'platform', 'install-ca', 'proxmox-01', '--json',
    ]);
    expect(exit).toBe(0);
  });

  it('connect-test against Proxmox succeeds', async () => {
    const exit = await cli.run([
      'platform', 'connect-test', 'proxmox-01', '--json',
    ]);
    expect(exit).toBe(0);
  });

  it('audit verify succeeds and chain is intact', async () => {
    const exit = await cli.run(['audit', 'verify', '--json']);
    expect(exit).toBe(0);
  });

  it('audit log contains expected events in order', async () => {
    const entries = await readAuditLog(tmpHomelabData);
    const events = entries.map(e => e.event);
    expect(events).toEqual([
      'consent_granted',
      'discovery_started',
      'discovery_completed',
      'ca_initialized',
      'cert_signed',           // From install-ca.
      'connection_opened',     // From install-ca.
      'command_executed',      // From install-ca's setup commands.
      'connection_closed',
      'connection_opened',     // From connect-test.
      'command_executed',      // The connect-test probe.
      'connection_closed',
    ]);
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  afterAll(async () => {
    restoreClock();
    await rm(tmpHomelabData, { recursive: true, force: true });
  });
});
```

Determinism rules:
- All timestamps go through `tests/utils/clock.ts` (a small wrapper around `Date.now`); `setClockFixed(iso)` pins it. The audit log's `timestamp` field is therefore reproducible.
- The `actor` field defaults to a fixed `'test-user'` unless overridden in the call (the `ca init` step uses `'admin-user'` to satisfy the admin middleware).
- The HMAC chain is deterministic because timestamps, payloads, and the audit key (regenerated per test run, but the chain still verifies internally) are stable.
- HTTP and SSH mocks are deterministic: identical request → identical canned response.

The test runs in CI without network access. If any step requires real I/O, the test fails immediately rather than hanging.

### Mocks

**`proxmox-api-mock.ts`:** Intercepts HTTPS calls to `https://192.168.1.50:8006/...`. Returns:
- `GET /api2/json/version` → `{ data: { version: '8.1.4', release: '8.1' } }`
- `POST /api2/json/access/ticket` → `{ data: { ticket: 'fake-ticket', CSRFPreventionToken: 'fake-token' } }`
- Any unexpected endpoint → 500 + log a warning so the test fails loudly.

**`ssh-mock.ts`:** Returns `whoami` → `root\n`, `sshd -t` → `\n` (success), and stubbed responses for the install-ca command sequence (writing TrustedUserCAKeys, restarting sshd). Any unexpected command throws `UnexpectedSshCommandError`.

**`clock.ts`:** Provides `setClockFixed(iso)` and `restoreClock()`. Internally swaps `Date.now`. The audit writer and any code emitting timestamps must read from this wrapper (one-line refactor in `audit/writer.ts`: `import { now } from '../tests/utils/clock'` — but production import is from a non-test path; resolved by build alias).

## Acceptance Criteria

- [ ] `tests/audit/test-writer.test.ts` covers all paths in `audit/writer.ts` and `audit/key-store.ts` with ≥95% line and ≥95% branch coverage (verified via `npm run test:coverage`).
- [ ] All `AuditWriter` and `AuditKeyStore` test groups documented above (`AuditKeyStore`, basic, concurrency, recovery, error handling) have at least one passing test each.
- [ ] `tests/connection/test-mcp-discovery.test.ts` covers all paths in `connection/mcp-discovery.ts` with ≥95% line and ≥95% branch coverage.
- [ ] All MCP discovery test cases documented above pass (missing file, malformed JSON, env opt-out, fixture parse, filtering, case sensitivity, command shape, `getForPlatform`).
- [ ] `tests/integration/test-operator-workflow.test.ts` runs all 7 sub-tests (`it` blocks) and they all pass.
- [ ] The integration test's audit-log assertion verifies the exact event sequence in order, with at least 8 entries.
- [ ] The integration test is deterministic: running it twice in succession with the same fixtures produces identical audit-log bytes (timestamps pinned, audit key persisted across the two runs, HMAC chain identical).
- [ ] The integration test runs without real network access (verified by spy on the actual `https`/`net` modules — any real connection attempt fails the test).
- [ ] Total test suite runtime ≤ 60 seconds on CI (no flakiness budget; fail if a single test takes > 10 s without explicit waiver).
- [ ] No new dependencies introduced beyond what existing PLAN-001-1/2 tests use (test framework, HTTP/SSH mocking libraries already in the project).

## Dependencies

- **Blocked by**: SPEC-001-3-01 (provides `MCPDiscovery` to test), SPEC-001-3-02 (provides `AuditWriter` to test), SPEC-001-3-03 (provides `audit verify` and `consent`/`ca` CLI used in the workflow), SPEC-001-3-04 (provides `platform exec`/`inventory remove` and admin-auth middleware exercised by the workflow).
- Test framework already in use by the homelab plugin (Jest, Vitest, or Mocha — match the project standard from PLAN-001-1/2 tests).
- Existing HTTP and SSH mocking libraries used in PLAN-001-2's tests (no new mocking framework introduced).

## Notes

- The unit-test specs listed in SPEC-001-3-01 and SPEC-001-3-02 are scoped (per-spec smoke tests). This spec produces the **comprehensive** versions targeting the ≥95% coverage gate. If a spec earlier in the chain shipped a test file, this spec extends it rather than replacing — file paths overlap intentionally.
- The integration test is intentionally narrow: one Proxmox host, one CIDR, one CA. Multi-platform integration is a future test once PLAN-002-* lands per-platform helpers. The goal here is to prove the wiring, not exhaustively cover all platform types.
- Determinism is non-negotiable. A flaky integration test in this layer would erode trust in the audit log's chain integrity. If a test is intermittently failing, the right response is to find the source of nondeterminism (clock, ordering, mock laxity), not retry.
- The clock injection requires a one-line touch to `audit/writer.ts` (changing the timestamp source from `new Date().toISOString()` to `now()`). This is a minor follow-up to SPEC-001-3-02 and should be done as part of implementing this spec; document the change in this spec's PR.
- Coverage gates are the floor, not the ceiling. If a test produces a higher number, that's fine. If a test produces less, the spec fails — implementer must add tests, not lower the gate.
- The integration test runs LAST in CI (alphabetically `tests/integration/...` sorts after `tests/audit/...` and `tests/connection/...`). If a unit test fails, the integration test is skipped. This keeps signal high.
