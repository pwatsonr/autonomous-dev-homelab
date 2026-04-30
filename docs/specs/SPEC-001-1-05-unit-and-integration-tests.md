# SPEC-001-1-05: Unit Tests + discover-flow Integration Test

## Metadata
- **Parent Plan**: PLAN-001-1
- **Tasks Covered**: Task 10 (unit tests for consent + discovery + inventory), Task 11 (end-to-end discover-flow integration test)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-1-05-unit-and-integration-tests.md`

## Description
Deliver the test suite that proves SPECs 001-1-01 through 001-1-04 satisfy PLAN-001-1's Definition of Done. Unit tests cover each module in isolation with mocked I/O (≥95% line coverage on `src/consent/**` and `src/discovery/**`); the integration test stands up real local HTTP servers emitting Unraid/Proxmox-like responses, runs the full `discover` flow with a mocked stdin for consent approval, and asserts the inventory file was written atomically with both platforms.

This spec adds no production code -- only test files, fixtures, and any test-only helpers (e.g., a tiny HTTP server harness). It depends on the production code from all four prior specs being implementable; failures here flag bugs in those specs, not in this one.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/tests/consent/test-manager.test.ts` | Create | ConsentManager unit tests |
| `plugins/autonomous-dev-homelab/tests/consent/test-fingerprint.test.ts` | Create | OS-aware fingerprint helpers |
| `plugins/autonomous-dev-homelab/tests/consent/test-schema.test.ts` | Create | network-consent-v1.json validation tests |
| `plugins/autonomous-dev-homelab/tests/discovery/test-fingerprints-catalog.test.ts` | Create | One test per platform fingerprint |
| `plugins/autonomous-dev-homelab/tests/discovery/test-prober.test.ts` | Create | PlatformProber unit tests with injected HttpClient |
| `plugins/autonomous-dev-homelab/tests/discovery/test-cidr.test.ts` | Create | enumerateHosts edge cases |
| `plugins/autonomous-dev-homelab/tests/discovery/test-inventory.test.ts` | Create | InventoryManager + atomic-write + mutex tests |
| `plugins/autonomous-dev-homelab/tests/discovery/test-inventory-schema.test.ts` | Create | inventory-v1.json validation tests |
| `plugins/autonomous-dev-homelab/tests/cli/test-discover.test.ts` | Create | `discover` CLI command, mocked deps |
| `plugins/autonomous-dev-homelab/tests/cli/test-inventory-cli.test.ts` | Create | `inventory list` CLI command |
| `plugins/autonomous-dev-homelab/tests/integration/test-discover-flow.test.ts` | Create | End-to-end discover flow, real HTTP fixtures |
| `plugins/autonomous-dev-homelab/tests/helpers/fixture-server.ts` | Create | Tiny http/https server emitting canned responses |
| `plugins/autonomous-dev-homelab/tests/helpers/temp-dir.ts` | Create | `mkdtemp`-based scratch dir per test, cleaned in teardown |
| `plugins/autonomous-dev-homelab/tests/helpers/mock-stdin.ts` | Create | Pushes scripted responses into a `ConsentManager`'s `promptFn` |

## Implementation Details

### Test Runner

Use the runner already standardized by autonomous-dev (likely `vitest`). Verify by checking `plugins/autonomous-dev-homelab/package.json` `scripts.test` before scaffolding; if the package.json doesn't yet exist for the homelab plugin, add it as part of this spec with the same runner choice as the parent plugin.

### Coverage Target

`vitest --coverage` (or equivalent) MUST report ≥95% line coverage and ≥90% branch coverage for the following directories:
- `src/consent/**`
- `src/discovery/**`

CLI directories (`src/cli/**`) target ≥85% line coverage -- the lower bar acknowledges that some error-printing branches (e.g., `EXIT_INTERNAL` catch-all) are tedious to exercise.

### Unit Test Inventory

Each unit test file MUST exhaustively exercise the acceptance criteria from its corresponding spec. A non-exhaustive sample of required cases:

**`test-manager.test.ts`** (consumes SPEC-001-1-01 ACs)
- Happy path: approval flow writes file with correct fingerprint and 90-day expiry.
- Expired consent returns null from `checkConsent`.
- Mismatched fingerprint returns null from `checkConsent`.
- Concurrent `requestConsent` for distinct CIDRs both succeed (mutex test).
- Atomic write: simulate `rename` failure → original file intact.
- `safeLoad`: feeding `!!js/function 'function(){}'` does NOT execute.
- Override env var bypasses `networkFingerprint()`.

**`test-fingerprint.test.ts`**
- Mock `child_process.exec` for `ip route show default` (Linux) → `192.168.1.1`.
- Mock `child_process.exec` for `route -n get default` (macOS) → `192.168.1.1`.
- Mock `/etc/resolv.conf` reading via `fs/promises.readFile`.
- Throw path: command rejects → returns `route=unknown;dns=`.

**`test-prober.test.ts`** (consumes SPEC-001-1-02 ACs)
- Inject a `FakeHttpClient` with a programmable response map.
- One match scenario (Proxmox response).
- No match scenario (404).
- Multiple matches on a single host (Docker + K8s).
- `permitted_scan_types` excludes `http_probe` → zero HTTP calls, returns `[]`.
- `permitted_ports` filter trims fingerprints.
- Concurrency cap: instrument fake client to assert max in-flight ≤ 50.
- Self-signed cert tolerance: assert `allowSelfSigned: true` is passed.

**`test-inventory.test.ts`** (consumes SPEC-001-1-03 ACs)
- All CRUD paths.
- 100-concurrent-add stress test → 100 entries, no interleaving.
- Atomic write crash simulation.
- Corrupted file → `INVALID_INVENTORY`.

**`test-discover.test.ts`** (consumes SPEC-001-1-04 ACs)
- Mock `ConsentManager`, `PlatformProber`, `InventoryManager`.
- Verify subprocess of: missing consent + `--no-prompt` → exit 2.
- Verify `--json` implies `--no-prompt`.
- Verify re-discovery calls `updatePlatform`, not `addPlatform`.
- Verify exit code matrix.

### Integration Test (`test-discover-flow.test.ts`)

This is the headline test for PLAN-001-1's Definition of Done.

```typescript
test('discover-flow: scan two-platform CIDR end-to-end', async () => {
  // 1. Spin up two fixture servers on ephemeral ports.
  const proxmox = await startFixtureServer({
    port: 8006,                            // bind to 127.0.0.1:8006 (or override via env)
    https: true,
    routes: { '/api2/json/version': { status: 200, body: '{"data":{"version":"8.1.4"}}' } }
  });
  const unraid = await startFixtureServer({
    port: 4443,                            // emulate :443 via nonstandard port for tests
    https: true,
    routes: { '/login': { status: 200, body: '<html>...Unraid.net...</html>' } }
  });

  // 2. Build a Consent over 127.0.0.1/32 with both probe ports permitted.
  const tempDir = await mkdtemp();
  const consentMgr = new ConsentManager(`${tempDir}/network_consent.yaml`, {
    promptFn: async () => true,            // auto-approve
  });
  await consentMgr.requestConsent('127.0.0.1/32', [8006, 4443], ['http_probe']);

  // 3. Build a prober with a one-off catalog patched to use the test ports.
  const catalog = [
    { ...PROXMOX_FINGERPRINT, probe: { ...PROXMOX_FINGERPRINT.probe, port: 8006 } },
    { ...UNRAID_FINGERPRINT,  probe: { ...UNRAID_FINGERPRINT.probe,  port: 4443 } },
  ];
  const prober = new PlatformProber({ catalog });

  // 4. Run discover end-to-end via the CLI handler (NOT spawning a subprocess --
  //    invoke `discover()` directly so we can assert on side effects).
  const inventoryMgr = new InventoryManager(`${tempDir}/inventory.yaml`);
  const exitCode = await runDiscover({
    cidr: '127.0.0.1/32',
    consentManager: consentMgr,
    prober,
    inventoryManager: inventoryMgr,
  });

  // 5. Assertions.
  expect(exitCode).toBe(0);
  const platforms = await inventoryMgr.listPlatforms();
  expect(platforms).toHaveLength(2);
  expect(platforms.map(p => p.type).sort()).toEqual(['proxmox-ve', 'unraid']);

  // 6. Inventory file is valid YAML matching the schema.
  const raw = await fs.readFile(`${tempDir}/inventory.yaml`, 'utf-8');
  const parsed = yaml.load(raw);
  expect(validateInventorySchema(parsed)).toBe(true);

  // 7. Cleanup.
  await proxmox.close(); await unraid.close();
});
```

### `fixture-server.ts` Helper

```typescript
export interface FixtureRoute {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export interface FixtureServerOpts {
  port: number;
  https: boolean;                          // self-signed cert generated on the fly
  routes: Record<string, FixtureRoute>;    // path → response
}
export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}
export async function startFixtureServer(opts: FixtureServerOpts): Promise<FixtureServer>;
```

For HTTPS, generate a self-signed cert at startup using Node's `crypto.generateKeyPair` + `selfsigned` package OR ship a pre-generated cert in `tests/fixtures/tls/` (preferred -- faster, deterministic). Cert validity period: 100 years (these are test-only).

### Determinism

- The integration test MUST NOT depend on real network reachability outside `127.0.0.1`.
- The integration test MUST NOT consume an env var for ports unless one is set; it picks ephemeral ports via `:0` binding and reads the actual port back from the server. Update the fixture catalog after binding.
- All tests MUST clean up temp directories in teardown (use `afterEach(() => rm(tempDir, { recursive: true, force: true }))`).
- No test may rely on wall-clock sleeps; use the runner's fake-timer support for expiry tests.

## Acceptance Criteria

- [ ] `npm test` (or the equivalent) runs all unit tests and exits 0 with no skipped tests.
- [ ] Coverage report shows ≥95% line coverage on `src/consent/**`.
- [ ] Coverage report shows ≥95% line coverage on `src/discovery/**`.
- [ ] Coverage report shows ≥85% line coverage on `src/cli/**`.
- [ ] `test-fingerprints-catalog.test.ts` includes one passing assertion per platform (7 tests minimum) -- each verifies the fingerprint matches a known-good fixture and rejects a generic nginx welcome page.
- [ ] `test-prober.test.ts` asserts max-in-flight ≤ 50 by instrumenting the fake `HttpClient` (counters incremented before await, decremented after).
- [ ] `test-inventory.test.ts` includes a 100-concurrent-add stress test that asserts exactly 100 entries in the file post-mutex-serialization.
- [ ] `test-manager.test.ts` includes a YAML safe-loader test: feeding `!!js/function` produces no execution and a clean error or load failure.
- [ ] `test-fingerprint.test.ts` runs equivalently on Linux and macOS by mocking `child_process.exec`; tests do NOT actually shell out.
- [ ] `test-discover.test.ts` exercises every documented exit code (`0`, `1`, `2`, `3`, `10`).
- [ ] `test-discover-flow.test.ts` runs end-to-end against two local fixture servers, requests consent via mocked `promptFn`, and asserts both platforms land in the inventory with the correct types and confidences.
- [ ] `test-discover-flow.test.ts` cleans up its temp dir AND closes both fixture servers in teardown -- verified by checking that no test artifacts remain after the suite runs.
- [ ] `test-discover-flow.test.ts` runs deterministically: 10 consecutive runs all pass.
- [ ] `test-discover-flow.test.ts` does NOT make any outbound network requests beyond `127.0.0.1` -- verified by setting `NODE_NETWORK_DISABLED` (or equivalent) and asserting tests still pass.
- [ ] No test depends on real wall-clock sleep; expiry tests use fake timers.
- [ ] The fixture HTTPS servers use a pre-generated self-signed cert from `tests/fixtures/tls/` (NOT generated at test time).
- [ ] Test output is silent on success (no stray console.log from production code under test).

## Dependencies

- Internal: ALL of SPEC-001-1-01, SPEC-001-1-02, SPEC-001-1-03, SPEC-001-1-04. This spec depends on every prior spec being implementable.
- External: `vitest` (or whichever runner the autonomous-dev plugin uses), `ajv` for schema validation, optionally `selfsigned` for cert generation if pre-generated certs are not used.
- Test-only fixtures: pre-generated self-signed cert + key in `tests/fixtures/tls/`.

## Notes

- The 95% coverage target is a guardrail, not a goal in itself. Tests MUST be meaningful (every test asserts a behavior, not just exercises lines). Reviewer should reject tests that exist solely to bump coverage numbers.
- The integration test deliberately invokes the `discover()` function directly (not via subprocess) so it can inject mocks and assert on side effects. A spawn-based smoke test belongs in PLAN-001-3's broader CLI test suite.
- `127.0.0.1/32` (single host) keeps the integration test fast (no `/24` enumeration). The prober's CIDR enumeration is independently covered by `test-cidr.test.ts`.
- Pre-generated self-signed certs trade slight repo bloat (a few KB) for major speed and determinism gains -- generating a cert per test run added ~1.5s startup overhead in early prototypes. Document the cert's expiry in `tests/fixtures/tls/README.md` so future maintainers regenerate before it expires (~2126).
- Network fingerprint tests do NOT shell out; doing so would couple the test suite to the host OS. The fingerprint helpers expose the `child_process.exec` and `fs.readFile` calls in a way the tests can mock.
- If the homelab plugin's `package.json` does not yet exist when this spec is implemented, the implementer creates it with `scripts.test` matching autonomous-dev's convention. Do NOT silently invent a new test runner -- match the parent plugin.
- The 10-consecutive-runs determinism check in the AC list is a smoke test for race conditions in the integration test setup (port binding, server startup ordering). If it ever fails, investigate before merging -- flake here masks bugs in the discover flow itself.
