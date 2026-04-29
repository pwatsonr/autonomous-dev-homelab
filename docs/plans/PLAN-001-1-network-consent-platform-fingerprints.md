# PLAN-001-1: Network Consent Model + Platform Fingerprints + Inventory Schema

## Metadata
- **Parent TDD**: TDD-001-platform-discovery-connection
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Deliver the foundational discovery layer for the autonomous-dev-homelab plugin: the per-CIDR network-consent model per TDD §5 (operator-approved scan ranges with fingerprint-based change detection and 90-day expiry), the platform-fingerprint catalog per TDD §6 (HTTP/HTTPS/TCP probes for Unraid, Proxmox, Docker, Kubernetes, UniFi, TrueNAS), and the inventory schema per TDD §7 (`<homelab-data>/inventory.yaml` with discovered platforms). The connection layer, SSH CA, MCP integration, and CLI surface are layered in by sibling plans.

## Scope
### In Scope
- `<homelab-data>/network_consent.yaml` schema per TDD §5: list of CIDR consents with `approved_at`, `approved_by`, `expires_at` (90 days default), `permitted_ports[]`, `permitted_scan_types[]`, `network_fingerprint`
- `ConsentManager` class per TDD §5 at `src/consent/manager.ts`: `checkConsent(cidr)`, `requestConsent(cidr, ports, scanTypes)`, `networkFingerprint()`. Network fingerprint is `route=<default-gw>;dns=<dns-servers>` for change detection.
- `requestConsent` interactive prompt: shows the network fingerprint and asks operator to confirm. On approval, writes to `network_consent.yaml`. On rejection, returns false.
- Network-change detection: when fingerprint differs from the stored one, the consent is invalidated and the operator must re-approve. Prevents drive-by scans on a different network (e.g., laptop on coffee-shop WiFi).
- Scan-type allowlist: `http_probe`, `ssh_probe`, `tcp_connect`. Only declared types may run for a given consent.
- Platform-fingerprint catalog at `src/discovery/fingerprints.ts` per TDD §6: declarative table mapping platform → probe (HTTP/HTTPS GET on a port) → expected response pattern → confidence score (0.85-0.99). Initial catalog covers Unraid, Proxmox VE, Docker, Kubernetes, Docker Swarm, UniFi, TrueNAS.
- `PlatformProber` at `src/discovery/prober.ts` that runs probes against IPs in a consented CIDR, matches responses against fingerprints, returns matched platforms with confidence
- `<homelab-data>/inventory.yaml` schema per TDD §7: list of discovered platforms with `id`, `type`, `host`, `port`, `ssh_host`, `ssh_port`, `discovered_at`, `last_seen`, `metadata` (platform-specific), `connection` (SSH cert path / MCP endpoint, decided in PLAN-001-2)
- `InventoryManager` at `src/discovery/inventory.ts` with `addPlatform`, `updatePlatform`, `getPlatform`, `listPlatforms`. Atomic writes via temp + rename.
- CLI `autonomous-dev-homelab discover [--cidr <cidr>]` triggers a scan with consent enforcement
- CLI `autonomous-dev-homelab inventory list [--type <platform>]` prints the inventory
- Unit tests for: consent expiry, fingerprint mismatch, network-change detection, scan-type enforcement, fingerprint matching for each platform
- Integration test: scan a fixture network with a fake HTTP server emitting a Proxmox-like response; verify discovery detects it

### Out of Scope
- Connection layer (SSH client, MCP client, command execution) -- PLAN-001-2
- SSH Certificate Authority -- PLAN-001-2
- MCP server discovery / preference -- PLAN-001-3
- Audit log -- PLAN-001-3
- Authentication for the CLI itself -- existing PRD-009 (homelab plugin reuses)
- Active monitoring / fault detection -- TDD-002 / PLAN-002-*
- Migration framework -- TDD-002 / PLAN-002-*
- Per-platform helper agents -- PLAN-002-2
- Auto-discovery of platforms outside the consented CIDRs (explicitly forbidden by design)

## Tasks

1. **Author `network_consent.yaml` schema** -- Create `plugins/autonomous-dev-homelab/schemas/network-consent-v1.json` with fields per TDD §5. Required: `version: '1.0'`, `consents[]` with `cidr`, `approved_at`, `expires_at`, `permitted_ports[]`, `permitted_scan_types[]`. Optional: `approved_by`, `note`, `network_fingerprint`.
   - Files to create: `plugins/autonomous-dev-homelab/schemas/network-consent-v1.json`
   - Acceptance criteria: Schema validates the TDD §5 example. Missing `cidr` fails. Invalid CIDR (`192.168.x.x/24`) fails. `permitted_scan_types` outside the enum fails.
   - Estimated effort: 1.5h

2. **Implement `ConsentManager`** -- Create `src/consent/manager.ts` per TDD §5 with `checkConsent`, `requestConsent`, `networkFingerprint`. Uses `js-yaml` for safe loading of the consent file.
   - Files to create: `plugins/autonomous-dev-homelab/src/consent/manager.ts`
   - Acceptance criteria: `checkConsent('192.168.1.50')` returns the matching consent for `192.168.1.0/24`. Expired consent returns null. Different-network fingerprint returns null. `requestConsent` prompts via stdin (interactive) and writes the file on approval. Tests cover all paths.
   - Estimated effort: 4h

3. **Implement network fingerprinting** -- `networkFingerprint()` returns `route=<default-gw>;dns=<dns1,dns2>` derived from `ip route show default` (Linux) or `route -n get default` (macOS) and `/etc/resolv.conf`. Documented as best-effort; operator can override for sensitive networks.
   - Files to modify: `plugins/autonomous-dev-homelab/src/consent/manager.ts`
   - Acceptance criteria: On Linux, returns `route=192.168.1.1;dns=192.168.1.1`. On macOS, similar. When the default gateway changes (simulated), the fingerprint differs, invalidating consent. Tests mock the underlying commands.
   - Estimated effort: 2h

4. **Author platform-fingerprint catalog** -- Create `src/discovery/fingerprints.ts` with the declarative table from TDD §6. Each fingerprint: `platformType`, `probe: {protocol, port, path}`, `expectedResponse: {regex|jsonPath, confidence}`. 7 platforms initially.
   - Files to create: `plugins/autonomous-dev-homelab/src/discovery/fingerprints.ts`
   - Acceptance criteria: All 7 platforms (Unraid, Proxmox VE, Docker, K8s, Docker Swarm, UniFi, TrueNAS) have entries with realistic probes and confidence scores. Tests verify each fingerprint matches against a fixture response.
   - Estimated effort: 3h

5. **Implement `PlatformProber`** -- Create `src/discovery/prober.ts` with `scan(cidr, consent)` that iterates IPs in the CIDR, runs allowed probes, matches responses, returns `MatchedPlatform[]`. Honors consent's `permitted_scan_types` and `permitted_ports`.
   - Files to create: `plugins/autonomous-dev-homelab/src/discovery/prober.ts`
   - Acceptance criteria: For a `/29` CIDR (8 IPs) with HTTP probe enabled, prober probes each IP. Matches by fingerprint regex/jsonPath. Returns platform type + confidence + IP. Tests use a local HTTP fixture server emitting Proxmox-like responses.
   - Estimated effort: 5h

6. **Author `inventory.yaml` schema** -- Create `plugins/autonomous-dev-homelab/schemas/inventory-v1.json` per TDD §7 with the platform shape (id, type, host, port, ssh_host, ssh_port, discovered_at, last_seen, metadata, connection).
   - Files to create: `plugins/autonomous-dev-homelab/schemas/inventory-v1.json`
   - Acceptance criteria: Schema validates the TDD §7 example. Missing `id` fails. `type` outside the enum fails. Optional fields handled correctly.
   - Estimated effort: 1.5h

7. **Implement `InventoryManager`** -- Create `src/discovery/inventory.ts` with atomic file writes (temp + rename) and CRUD operations. Concurrent calls serialize via a per-file mutex.
   - Files to create: `plugins/autonomous-dev-homelab/src/discovery/inventory.ts`
   - Acceptance criteria: `addPlatform` writes atomically; concurrent adds don't interleave. `updatePlatform` preserves fields not in the update. `getPlatform(id)` returns the matching entry or null. Tests cover all paths plus concurrency.
   - Estimated effort: 3h

8. **Implement `discover` CLI subcommand** -- `autonomous-dev-homelab discover [--cidr <cidr>]` triggers scan against the given CIDR (or all consented CIDRs by default). Calls ConsentManager → PlatformProber → InventoryManager. Reports matches with confidence.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/discover.ts`
   - Acceptance criteria: `discover --cidr 192.168.1.0/24` requests consent if missing, scans, prints matches. Without consent, exits 1 with clear message. JSON output mode emits structured discovery results.
   - Estimated effort: 2h

9. **Implement `inventory list` CLI subcommand** -- `autonomous-dev-homelab inventory list [--type <platform>] [--json]` prints the inventory in tabular form.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/inventory.ts`
   - Acceptance criteria: `inventory list` shows columns: id, type, host:port, last_seen. `--type proxmox-ve` filters. `--json` emits structured. Tests cover both modes.
   - Estimated effort: 1.5h

10. **Unit tests** -- `tests/consent/test-manager.test.ts`, `tests/discovery/test-prober.test.ts`, `test-inventory.test.ts` covering all paths. Use fixture YAML files and mocked network/filesystem calls.
    - Files to create: three test files
    - Acceptance criteria: All tests pass. Coverage ≥95% on consent + discovery modules. Fixture-based tests are deterministic.
    - Estimated effort: 4h

11. **Integration test: discover-and-inventory** -- `tests/integration/test-discover-flow.test.ts` that starts a local HTTP server emitting Unraid/Proxmox-like responses on different ports, requests consent (mocked stdin), runs discovery, verifies inventory contains both platforms.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-discover-flow.test.ts`
    - Acceptance criteria: Test passes deterministically. Two platforms discovered with the right confidence. Inventory file written atomically.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `ConsentManager` consumed by PLAN-001-2 (connection layer requires consent before connecting), PLAN-001-3 (CLI commands), and PLAN-002-* (observation probes operate on consented platforms).
- Platform-fingerprint catalog consumed by future plugins that add new platform types.
- `inventory.yaml` schema consumed by PLAN-001-2/3 and PLAN-002-* for connection routing and observation targeting.
- Network-change detection pattern reusable for any future security-sensitive operation.

**Consumes from other plans:**
- TDD-007 / PLAN-007-X (autonomous-dev): existing config infrastructure for `<homelab-data>` location resolution.
- PRD-009 (autonomous-dev): admin role for consent approval (operator authentication).

**Consumes from external:**
- `js-yaml` for safe YAML loading.
- `ip route` (Linux) / `route` (macOS) for network fingerprinting.

## Testing Strategy

- **Unit tests (task 10):** Consent expiry, fingerprint matching, prober behavior, inventory CRUD. ≥95% coverage.
- **Integration test (task 11):** End-to-end discover flow with local HTTP fixtures.
- **Fingerprint accuracy test:** Each platform's fingerprint matches a known-good response and rejects a similar-but-different response.
- **Network-change test:** Fingerprint mismatch invalidates consent; new fingerprint requires re-approval.
- **Manual smoke:** Real homelab network with at least 2 platforms; verify discovery and inventory.
- **Negative tests:** Scan without consent rejected. Probe outside `permitted_scan_types` rejected. CIDR not in any consent rejected.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Fingerprint catalog drifts as platforms version (e.g., new Unraid UI HTML changes) | High | Medium -- false negatives | Each fingerprint has a confidence score; low confidence (<0.7) triggers manual operator confirmation. Annual catalog review. Operators can add custom fingerprints in `<homelab-data>/custom-fingerprints.yaml`. |
| Network fingerprinting fails on systems with non-standard network stacks (e.g., systemd-resolved with split DNS) | Medium | Low -- fingerprint quality degrades | Fingerprint is best-effort; operators can override via `<homelab-data>/network-override.yaml`. Documented in operator guide. |
| Scanning a CIDR with many hosts (`/16` = 65k IPs) is slow | Medium | Low -- discovery takes minutes | Configurable concurrency: parallelize 50 probes by default. `/16` scan completes in ~5 minutes. Documented as a known characteristic. Operators can split `/16` into multiple `/24` consents for selective scans. |
| Operator approves a CIDR via `requestConsent` but inventory file write fails (disk full) | Low | High -- consent applied but no record | Atomic file writes (temp + rename); failure aborts before partial state. Tests cover the failure mode. |
| Probe traffic looks suspicious to network IDS, triggering alerts | Medium | Low -- ops noise | Probes are HTTP/HTTPS GETs on standard ports — indistinguishable from monitoring traffic. Documented in operator guide. Recommendation: add the daemon's IP to the network's allowlist. |
| Probe accidentally hits a sensitive endpoint (e.g., `/admin` of a non-target service) | Low | Medium -- triggers alarms | Probes target SPECIFIC paths declared in fingerprints (e.g., `/api/v2.0/system/info` for TrueNAS, not `/admin`). Tests verify no fingerprint includes a generic path like `/`. |

## Definition of Done

- [ ] `network_consent.yaml` schema validates the TDD §5 example
- [ ] `ConsentManager` correctly handles approval, expiry, and network-change detection
- [ ] Network fingerprinting works on Linux and macOS
- [ ] Platform-fingerprint catalog covers all 7 documented platforms
- [ ] `PlatformProber` matches responses against fingerprints with correct confidence
- [ ] `inventory.yaml` schema validates the TDD §7 example
- [ ] `InventoryManager` atomic writes prevent corruption under concurrency
- [ ] `discover` and `inventory list` CLI subcommands work with JSON output
- [ ] Unit tests pass with ≥95% coverage
- [ ] Integration test demonstrates end-to-end discover flow against local HTTP fixtures
- [ ] Scan without consent is rejected with a clear message
- [ ] Operator documentation explains the consent model and platform fingerprints
