# PLAN-001-3: MCP Integration + Audit Log + Operator CLI Suite

## Metadata
- **Parent TDD**: TDD-001-platform-discovery-connection
- **Estimated effort**: 3 days
- **Dependencies**: []
- **Blocked by**: [PLAN-001-1, PLAN-001-2]
- **Priority**: P0

## Objective
Complete the discovery + connection layer with operator-facing surfaces: MCP server discovery per TDD §10 (probes for installed mcp-server-* per platform, prefers them when available, gracefully falls back), the comprehensive audit log per TDD §12 (HMAC-chained log of every connection, exec, cert-sign, revoke, consent-grant event), the authentication layer per TDD §11 (admin role enforcement on destructive CLI subcommands), and the full operator CLI surface per TDD §13 (`discover`, `inventory list`, `platform connect-test`, `platform install-ca`, `consent list/grant/revoke`, `ca init/rotate`, `audit verify/query`).

## Scope
### In Scope
- `MCPDiscovery` at `src/connection/mcp-discovery.ts` per TDD §10: at startup, parses operator's `~/.config/claude/.mcp.json`, identifies installed `mcp-server-*` matching the homelab platform list, registers each as available
- Per-platform MCP availability: each entry in `inventory.yaml` updates `connection.mcp_endpoint` if the corresponding `mcp-server-<platform>` is installed
- Authentication per TDD §11: destructive CLI operations (CA init, cert revocation, consent revocation) require operator authentication via the existing autonomous-dev admin role (PRD-009)
- Audit log per TDD §12 at `<homelab-data>/audit.log` (JSONL): every connection (success/failure), every exec command, every cert sign/revoke, every consent grant/revoke, every discovery event. HMAC-chained identical to PLAN-019-4's pattern.
- `audit verify` CLI subcommand walks the audit log and verifies the HMAC chain
- `audit query` CLI with filters: `--platform <id>`, `--event <type>`, `--since <ts>`, `--actor <user>`
- Full operator CLI surface per TDD §13:
  - `autonomous-dev-homelab discover [--cidr <cidr>]` (PLAN-001-1)
  - `autonomous-dev-homelab inventory list/get/remove` (PLAN-001-1 + this plan adds get/remove)
  - `autonomous-dev-homelab platform install-ca <id>` (PLAN-001-2)
  - `autonomous-dev-homelab platform connect-test <id>` (PLAN-001-2)
  - `autonomous-dev-homelab platform exec <id> -- <command>` (this plan)
  - `autonomous-dev-homelab consent list/grant/revoke` (this plan)
  - `autonomous-dev-homelab ca init/rotate <id>/list` (this plan)
  - `autonomous-dev-homelab audit verify/query` (this plan)
- All CLI commands have `--json` output mode and consistent error reporting
- Unit tests for MCP discovery, audit-log writer, query filters
- Integration test: discover → install-ca → connect via MCP (mocked) → exec → audit log shows all events

### Out of Scope
- Network consent + platform fingerprinting + inventory schema -- delivered by PLAN-001-1
- Connection layer + SSH CA -- delivered by PLAN-001-2
- Active monitoring / fault detection -- TDD-002
- Migration framework -- TDD-002
- Per-platform helper agents -- PLAN-002-2
- MCP server installation (assumed already done by operator) — this plan only discovers what's installed

## Tasks

1. **Implement `MCPDiscovery`** -- Create `src/connection/mcp-discovery.ts` that reads operator's `~/.config/claude/.mcp.json`, identifies entries matching `mcp-server-{proxmox,kubernetes,docker,unraid,unifi,truenas}`, returns list of available MCP servers.
   - Files to create: `plugins/autonomous-dev-homelab/src/connection/mcp-discovery.ts`
   - Acceptance criteria: With `.mcp.json` containing `mcp-server-proxmox` and `mcp-server-kubernetes`, returns both. Without the file, returns empty. Tests use fixture `.mcp.json` files.
   - Estimated effort: 2h

2. **Wire MCP discovery into inventory updates** -- After running `autonomous-dev-homelab discover`, update each new platform's `connection.mcp_endpoint` if the corresponding mcp-server is in MCPDiscovery's list.
   - Files to modify: `plugins/autonomous-dev-homelab/src/cli/commands/discover.ts`
   - Acceptance criteria: Discovered Proxmox platform has `connection.mcp_endpoint: 'mcp-server-proxmox'` if installed; otherwise null. Tests verify the update with both mcp-installed and mcp-absent fixtures.
   - Estimated effort: 2h

3. **Implement audit log writer** -- Create `src/audit/writer.ts` reusing the HMAC-chained pattern from autonomous-dev's PLAN-019-4. Audit file at `<homelab-data>/audit.log`. Auto-generates `HOMELAB_AUDIT_KEY` on first run if absent. Concurrent writes serialized via mutex.
   - Files to create: `plugins/autonomous-dev-homelab/src/audit/writer.ts`
   - Acceptance criteria: Writing 1000 entries produces 1000 lines, HMAC chain intact. Concurrent writes don't interleave. Daemon restart resumes from the last entry's HMAC. Tests verify chain integrity.
   - Estimated effort: 3h

4. **Wire audit-log emission into all destructive operations** -- Every consent grant/revoke, every CA init/rotate, every cert sign/revoke, every connection (success/failure), every exec call emits an audit entry.
   - Files to modify: `plugins/autonomous-dev-homelab/src/consent/manager.ts`, `src/ca/manager.ts`, `src/connection/{base,pool}.ts`
   - Acceptance criteria: After running `discover` + `install-ca` + `connect-test`, the audit log has at least 5 entries: `discovery_started`, `discovery_completed`, `cert_signed`, `connection_opened`, `command_executed`. Each entry has the correct shape with `actor`, `platform`, `event`, `timestamp`, `payload`.
   - Estimated effort: 3h

5. **Implement `audit verify` and `audit query` CLI** -- `audit verify` walks the log and verifies the HMAC chain. `audit query` filters by `--platform`, `--event`, `--since`, `--actor` (and combinations).
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/audit.ts`
   - Acceptance criteria: `audit verify` exits 0 on clean log, 1 on tampered. `audit query --platform proxmox-01 --since 2026-04-28` returns matching entries. `--json` emits structured. Tests cover clean and tampered logs.
   - Estimated effort: 2h

6. **Implement `consent list/grant/revoke` CLI** -- `consent list [--json]` shows all active consents. `consent grant <cidr>` interactively requests approval (delegates to `ConsentManager.requestConsent`). `consent revoke <cidr>` removes a consent (admin-only).
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/consent.ts`
   - Acceptance criteria: `list` shows columns: cidr, approved_at, expires_at, ports, scan_types. `grant` prompts and writes. `revoke` removes (verifies admin role; emits audit entry). Tests cover all three subcommands.
   - Estimated effort: 2.5h

7. **Implement `ca init/rotate/list` CLI** -- `ca init` creates the CA with operator passphrase (interactive). `ca rotate <platform-id>` revokes + signs new (admin-only). `ca list` lists all signed certs with expiry.
   - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/ca.ts`
   - Acceptance criteria: `ca init` runs `SSHCertificateManager.initializeCA`. `ca rotate` runs the rotation flow. `ca list` shows columns: platform-id, signed_at, expires_at, status (active/revoked). Tests cover all three.
   - Estimated effort: 2h

8. **Implement `platform exec <id> -- <command>` CLI** -- Operator-facing exec subcommand: opens a connection, runs the command, prints structured result. Admin-only (every exec is privileged).
   - Files to modify: `plugins/autonomous-dev-homelab/src/cli/commands/platform.ts`
   - Acceptance criteria: `platform exec proxmox-01 -- whoami` prints `root`. Failed connection produces a diagnostic. Every exec emits an audit entry with the command. Tests cover success and failure paths.
   - Estimated effort: 2h

9. **Implement `inventory get` and `inventory remove`** -- `inventory get <id>` prints full platform record. `inventory remove <id>` deletes from inventory + revokes its cert (admin-only).
   - Files to modify: `plugins/autonomous-dev-homelab/src/cli/commands/inventory.ts` (existing in PLAN-001-1)
   - Acceptance criteria: `get proxmox-01` prints all platform fields. `remove proxmox-01` removes from inventory and calls `SSHCertificateManager.revokeKeys`. Audit entry emitted. Tests cover both.
   - Estimated effort: 1.5h

10. **Authentication enforcement on all destructive CLI** -- Wrap every destructive subcommand (`consent revoke`, `ca init`, `ca rotate`, `inventory remove`, `platform exec`) with the admin-role check from PRD-009.
    - Files to modify: relevant CLI command files
    - Acceptance criteria: Non-admin invocation of any destructive subcommand exits 1 with `Authorization required: admin role`. Admin invocation succeeds. Tests cover both for each subcommand.
    - Estimated effort: 1.5h

11. **Unit tests for audit log + MCP discovery** -- `tests/audit/test-writer.test.ts`, `test-mcp-discovery.test.ts` covering all paths.
    - Files to create: two test files
    - Acceptance criteria: All tests pass. Coverage ≥95% on `audit/writer.ts` and `connection/mcp-discovery.ts`.
    - Estimated effort: 2h

12. **Integration test: full operator workflow** -- `tests/integration/test-operator-workflow.test.ts` that runs: `consent grant 192.168.1.0/24` → `discover` → `ca init` → `platform install-ca proxmox-01` → `platform connect-test proxmox-01` → `audit verify`. Asserts each step emits the right audit entries.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-operator-workflow.test.ts`
    - Acceptance criteria: All 6 steps complete in order. Audit log has at least 8 entries with correct types. Test runs against fixtures (mocked HTTP/SSH); deterministic.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- `MCPDiscovery` consumed by PLAN-001-2's connection auto-selection (the connection now knows whether MCP is available before attempting it).
- Audit log writer consumed by PLAN-002-* (every observation, fault, fix-action emits to this log).
- CLI surface consumed by operators day-to-day; future plans extend (e.g., PLAN-002-3 adds `homelab observe` subcommands).
- Authentication-wrap pattern reusable for any future destructive subcommand.

**Consumes from other plans:**
- **PLAN-001-1** (blocking): `ConsentManager`, `InventoryManager`. CLI commands wrap these.
- **PLAN-001-2** (blocking): `Connection`, `SSHCertificateManager`. CLI commands wrap these.
- **PLAN-019-4** (autonomous-dev): HMAC-chained audit log pattern reused.
- PRD-009 (autonomous-dev): admin role for destructive operations.

## Testing Strategy

- **Unit tests (task 11):** Audit writer chain integrity, MCP discovery file parsing. ≥95% coverage.
- **Integration test (task 12):** End-to-end operator workflow with all major commands.
- **Auth-enforcement test:** Each destructive command rejects non-admin; accepts admin.
- **Audit log tamper detection:** Generate a clean log, mutate one entry, run `audit verify`, expect failure.
- **CLI consistency check:** All commands have `--json` mode; all destructive ones require admin; all emit audit entries. Documented as a CI lint.
- **Manual smoke:** Real homelab end-to-end with real MCP servers installed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Audit-log key (`HOMELAB_AUDIT_KEY`) loss makes existing entries unverifiable | Medium | Medium -- forensics broken for prior period | Same recovery as autonomous-dev's audit-key loss: log warning, regenerate, write rotation entry. Pre-rotation entries become unverifiable. Documented. |
| MCP discovery parses operator's `.mcp.json` and exposes installed servers — privacy concern | Low | Low -- only enumerates names | Documented in operator guide that MCP discovery reads the user's MCP config. Operator can opt out via env var `HOMELAB_DISABLE_MCP_DISCOVERY=1`. |
| `platform exec <command>` is convenient but lets operators run arbitrary commands without context — easy to forget what was done | High | Low -- operator confusion | Every exec is in the audit log. `audit query --event command_executed --platform <id>` shows history. Operator guide recommends documenting non-trivial exec commands in a runbook. |
| Inventory remove deletes the platform record but doesn't notify the platform to remove the CA pubkey | Medium | Low -- stale TrustedUserCAKeys entry | Documented as a known limitation. The cert is revoked (via revocation list), so even if the pubkey remains, signed certs are rejected. Operators can manually remove the pubkey if desired. |
| `consent grant` for a `/16` CIDR is approved but operator didn't realize the scope | High | Medium -- broad scan permission | `requestConsent` displays the IP count and asks for explicit confirmation for CIDRs larger than /24. Documented as a safety check. |
| Audit log JSONL format makes parsing slow on large logs (1M+ entries) | Low | Low -- query latency grows | Index file `<homelab-data>/audit.idx` (future enhancement) speeds queries. Today, query is O(n); 1M entries take ~10s. Documented. Operators rotate the log periodically (existing PLAN-019-4 rotation pattern applies). |

## Definition of Done

- [ ] `MCPDiscovery` correctly identifies installed mcp-server-* from `.mcp.json`
- [ ] Inventory entries get `connection.mcp_endpoint` populated when MCP is available
- [ ] Audit log writer emits HMAC-chained entries to `<homelab-data>/audit.log`
- [ ] `HOMELAB_AUDIT_KEY` auto-generated on first run with mode 0600
- [ ] All destructive operations emit audit entries
- [ ] `audit verify` detects tampering; `audit query` filters work correctly
- [ ] Full CLI surface implemented: `discover`, `inventory`, `platform`, `consent`, `ca`, `audit`
- [ ] All CLI commands have `--json` output mode
- [ ] Destructive subcommands require admin role
- [ ] Unit tests pass with ≥95% coverage on new modules
- [ ] Integration test demonstrates full operator workflow
- [ ] Operator documentation covers all CLI subcommands with examples
- [ ] No regressions in PLAN-001-1/2 functionality
