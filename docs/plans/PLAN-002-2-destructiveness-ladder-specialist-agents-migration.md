# PLAN-002-2: Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration

## Metadata
- **Parent TDD**: TDD-002-observation-autofix-migration
- **Estimated effort**: 6 days
- **Dependencies**: []
- **Blocked by**: [PLAN-002-1]
- **Priority**: P0

## Objective
Wire the safety-critical layers of the homelab autofix workflow: the destructiveness ladder enforcement per TDD §8 that maps each operation's destructiveness category to a minimum trust-level floor (cannot be configured below the floor at the framework level), the seven specialist agents per TDD §9 (proxmox-expert, kubernetes-expert, unraid-expert, unifi-expert, freenas-expert, docker-expert, homelab-observability-expert) that produce fix plans honoring the ladder, the migration framework per TDD §10 with declarative migration plans and 24-hour delays for architectural changes, and backup orchestration per TDD §11 that verifies a recent backup exists before any data-affecting or architectural operation. Together these prevent the autonomous system from making irreversible mistakes on operator infrastructure.

## Scope
### In Scope
- `Destructiveness` type enum at `src/safety/destructiveness.ts` per TDD §8: `read-only`, `reversible`, `persistent-modifying`, `data-affecting`, `architectural`
- `FLOOR` mapping per TDD §8: each destructiveness level has a required trust-level floor that cannot be configured lower
  - `read-only`: L3 OK
  - `reversible`: L1 (operator approval per request)
  - `persistent-modifying`: L0
  - `data-affecting`: L0 + typed-CONFIRM modal
  - `architectural`: L0 + dry-run + 24h delay + typed-CONFIRM
- `validateOperatorConfig(config)` at `src/safety/validator.ts`: runs at config-load time, throws `ConfigurationError` if operator attempts to lower trust below floor
- `gateApproval(action)` at `src/safety/gate.ts` per TDD §8: enforces the ladder at action-execution time. For `data-affecting`, prompts typed-CONFIRM via the existing approval-gate UI. For `architectural`, runs dry-run + 24h delay + typed-CONFIRM.
- Typed-CONFIRM modal: requires operator to type the literal word `CONFIRM` (not just "yes"). Modal expires after 60s of inactivity (configurable). Bypass requires admin role.
- 24-hour delay enforcement: scheduled via `setTimeout` in the daemon (or via cron + state file). Daemon survives restarts (state persists). Operators can review the dry-run report during the delay window and cancel via `homelab cancel-action <id>`.
- Seven specialist agents per TDD §9 at `plugins/autonomous-dev-homelab/agents/`:
  - `proxmox-expert.md`: tools `Read, Glob, Grep, Bash(pct *), Bash(qm *), Bash(pvesh *)`
  - `kubernetes-expert.md`: tools `Read, Glob, Grep, Bash(kubectl *), Bash(helm *)`
  - `unraid-expert.md`: tools `Read, Glob, Grep, Bash(emhttp *)` (Unraid's CLI)
  - `unifi-expert.md`: read-only (HTTPS API queries via Read; no Bash)
  - `freenas-expert.md`: tools `Read, Glob, Grep, Bash(zpool *), Bash(zfs *)`
  - `docker-expert.md`: tools `Read, Glob, Grep, Bash(docker *)`
  - `homelab-observability-expert.md`: tools `Read, Glob, Grep` (read-only; produces dashboards and analyses, not fixes)
- Each agent's prompt includes the destructiveness ladder and a directive: "you CANNOT bypass the ladder. If the only fix requires `data-affecting + L0` and the operator hasn't pre-approved, halt and report."
- `Migration` schema at `src/migration/types.ts` per TDD §10: declarative migration plan with `migration_id`, `source_platform`, `target_platform`, `classification: 'architectural'` (always L0), `phases[]` (identify-resources, plan-target, dry-run, approval-delay, execute)
- `MigrationOrchestrator` at `src/migration/orchestrator.ts` that runs through phases, persisting state at each step. Approval-delay phase has `duration: 24h` and `requires_typed_confirm: true`. Execute phase only runs after explicit operator approval at the end of the delay.
- Backup orchestration at `src/backup/orchestrator.ts` per TDD §11: before any `data-affecting` or `architectural` action, verify a recent backup exists in the `<homelab-data>/backup-manifest.json`. If no recent backup, refuse the action and emit a backup-needed escalation.
- Backup manifest schema: `{platform, backup_type, taken_at, location, size_bytes, hmac}`. Updated by external backup processes (this plan doesn't take backups itself; it verifies their presence).
- CLI `homelab safety check <action-id>` previews what destructiveness/floor a proposed action has and what approvals would be required
- CLI `homelab cancel-action <id>` cancels a pending action (e.g., during 24h delay)
- CLI `homelab migrations status [--id <id>]` shows in-flight and recent migrations
- Unit tests for: ladder enforcement (each destructiveness × each trust level), typed-CONFIRM, 24h delay persistence across daemon restart, migration orchestrator phase transitions, backup verification
- Integration test: full migration end-to-end (mocked) including 24h delay simulation

### Out of Scope
- Fault probes and observation collection -- delivered by PLAN-002-1
- Homelab deploy backends -- PLAN-002-3
- Portal integration -- PLAN-002-3
- Audit & safety metrics -- PLAN-002-3
- Backup taking (this plan only verifies; actual backups handled by operator's existing tooling)
- Disaster-recovery automation -- ops concern

## Tasks

1. **Author destructiveness types and ladder** -- Create `src/safety/destructiveness.ts` with the enum and the `FLOOR` constant per TDD §8.
   - Files to create: `plugins/autonomous-dev-homelab/src/safety/destructiveness.ts`
   - Acceptance criteria: TypeScript compiles. `FLOOR['data-affecting']` returns `L0`. `FLOOR['read-only']` returns `L3`. JSDoc cites TDD §8.
   - Estimated effort: 1.5h

2. **Implement `validateOperatorConfig`** -- Create `src/safety/validator.ts` per TDD §8. Reads the operator's `auto_approval` config; throws if any level is below its floor.
   - Files to create: `plugins/autonomous-dev-homelab/src/safety/validator.ts`
   - Acceptance criteria: Config with `auto_approval.data-affecting: L1` throws `ConfigurationError`. With `auto_approval.read-only: L3` succeeds. Tests cover all 5×4 combinations (5 destructiveness × 4 trust levels).
   - Estimated effort: 2h

3. **Implement `gateApproval`** -- Create `src/safety/gate.ts` per TDD §8. For `read-only`: pass-through. For `reversible` + L1: standard approval flow. For `data-affecting`: typed-CONFIRM modal. For `architectural`: dry-run + 24h delay + typed-CONFIRM.
   - Files to create: `plugins/autonomous-dev-homelab/src/safety/gate.ts`
   - Acceptance criteria: Each path tested with mocked approval/UI. Tests verify typed-CONFIRM rejects non-`CONFIRM` input, 24h delay correctly persists across restarts, dry-run output is included in the approval prompt.
   - Estimated effort: 5h

4. **Implement typed-CONFIRM modal** -- Create `src/safety/typed-confirm.ts` that prompts the operator (via CLI or via the portal — both supported). 60s timeout. Operator must type the literal word `CONFIRM`. Wrong input rejects.
   - Files to create: `plugins/autonomous-dev-homelab/src/safety/typed-confirm.ts`
   - Acceptance criteria: `typedConfirmModal({message: 'X', ttl_seconds: 60})` waits up to 60s. Input `CONFIRM` resolves true. Input `confirm` (lowercase) resolves false. No input within 60s resolves false. Tests use mocked stdin.
   - Estimated effort: 2.5h

5. **Implement 24-hour delay with persistence** -- Create `src/safety/delay.ts` that schedules an action for 24h later. State persists at `<homelab-data>/pending-actions/<action-id>.json` (HMAC-signed). On daemon restart, pending actions are loaded; expired ones fire immediately.
   - Files to create: `plugins/autonomous-dev-homelab/src/safety/delay.ts`
   - Acceptance criteria: Schedule a 24h delay; daemon restarts at T+12h; on restart, the remaining 12h is honored. Action fires at T+24h. Cancel during the delay marks the action as cancelled. Tests use mocked timers + simulated restarts.
   - Estimated effort: 4h

6. **Author seven specialist agent files** -- Create the 7 agent files per TDD §9 with frontmatter (name, description, model, tools) and system prompts that include the destructiveness ladder.
   - Files to create: 7 `.md` files under `plugins/autonomous-dev-homelab/agents/`
   - Acceptance criteria: Each agent passes the agent-meta-reviewer (PLAN-017-2 of autonomous-dev) for tool restrictions. Tools are minimum required: read-only where possible, narrow Bash patterns elsewhere. Each prompt includes "you CANNOT bypass the ladder."
   - Estimated effort: 5h

7. **Author Migration schema and types** -- Create `src/migration/types.ts` with the `Migration` interface per TDD §10. JSON schema at `schemas/migration-v1.json`.
   - Files to create: `plugins/autonomous-dev-homelab/src/migration/types.ts`, `plugins/autonomous-dev-homelab/schemas/migration-v1.json`
   - Acceptance criteria: TypeScript compiles. Schema validates the TDD §10 example. Missing required field fails. `classification: 'architectural'` is enforced (no other value allowed).
   - Estimated effort: 2h

8. **Implement `MigrationOrchestrator`** -- Create `src/migration/orchestrator.ts` per TDD §10. Iterates phases: identify-resources → plan-target → dry-run → approval-delay (24h) → execute. State persists at each phase.
   - Files to create: `plugins/autonomous-dev-homelab/src/migration/orchestrator.ts`
   - Acceptance criteria: Each phase runs in order. State persisted. Dry-run report included in approval prompt. 24h delay correctly enforced. Execute phase only runs after typed-CONFIRM. Tests use mocked timers.
   - Estimated effort: 5h

9. **Implement backup verification** -- Create `src/backup/orchestrator.ts` that reads `<homelab-data>/backup-manifest.json` and verifies a recent backup (per platform-specific freshness rules: e.g., zfs pools < 24h, container images < 7d).
   - Files to create: `plugins/autonomous-dev-homelab/src/backup/orchestrator.ts`
   - Acceptance criteria: Action targeting Proxmox without a fresh `pve-backup` entry refuses with `BackupNotFoundError`. With a fresh backup, proceeds. Tests cover both paths plus stale-backup case.
   - Estimated effort: 2h

10. **Wire backup verification into `gateApproval`** -- For `data-affecting` and `architectural` actions, `gateApproval` now also calls `backupOrchestrator.verify(action.target)` before approving. If verification fails, refuses with the backup-needed escalation.
    - Files to modify: `plugins/autonomous-dev-homelab/src/safety/gate.ts`
    - Acceptance criteria: Approval for a data-affecting action without backup is rejected with `BackupRequiredError`. Operator can override via `--skip-backup-check` flag (admin-only, audit-logged). Tests cover both.
    - Estimated effort: 1.5h

11. **Implement `homelab safety/cancel-action/migrations` CLI** -- `safety check <action>` previews destructiveness + floor. `cancel-action <id>` cancels a pending action. `migrations status [--id <id>]` shows in-flight migrations.
    - Files to create: `plugins/autonomous-dev-homelab/src/cli/commands/{safety,cancel-action,migrations}.ts`
    - Acceptance criteria: All three subcommands work with `--json` mode. Cancel emits audit entry. Migration status shows current phase + remaining time. Tests cover all three.
    - Estimated effort: 3h

12. **Unit tests for ladder, gate, delay, migration, backup** -- One test file per component covering all paths. Includes ladder truth-table tests (5 destructiveness × 4 trust × allowed/denied = 20 cases).
    - Files to create: 5+ test files under `plugins/autonomous-dev-homelab/tests/safety/` and `tests/migration/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on safety + migration modules.
    - Estimated effort: 5h

13. **Integration test: end-to-end migration with 24h delay** -- `tests/integration/test-migration-flow.test.ts` that runs a full migration (mocked phases). 24h delay is simulated via fast-forwarded timers. Verifies: each phase runs, dry-run report generated, approval prompt fires, 24h delay enforced (via timer), execute phase runs after CONFIRM.
    - Files to create: `plugins/autonomous-dev-homelab/tests/integration/test-migration-flow.test.ts`
    - Acceptance criteria: Test passes deterministically. Each phase's state is persisted. Cancel during the delay aborts the migration. Tests run in <30s (with mocked timers).
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- Destructiveness ladder + `gateApproval` consumed by PLAN-002-3 (homelab deploy backends apply the gate before each backend operation).
- Specialist agent definitions consumed by autonomous-dev's request flow (when a homelab observation promotes to a request, the appropriate specialist agent is invoked).
- Migration orchestrator consumed by future migration plans (e.g., a Portainer→K3s migration plugin extends this).
- 24h delay + typed-CONFIRM patterns reusable for any future high-stakes action.

**Consumes from other plans:**
- **PLAN-002-1** (blocking): Observation → request promotion that drives the gate.
- TDD-018 / PLAN-018-3 (autonomous-dev): request_type and destructiveness tagging.
- PRD-009 (autonomous-dev): trust ladder and admin role definitions.
- PLAN-017-2 (autonomous-dev): agent-meta-reviewer audits the new specialist agents at registration.
- PLAN-001-3 (homelab): audit log writer for safety events.

## Testing Strategy

- **Unit tests (task 12):** Ladder truth-table, gate enforcement, delay persistence, migration phases, backup verification. ≥95% coverage.
- **Integration test (task 13):** End-to-end migration with simulated 24h delay.
- **Restart simulation:** Daemon-restart mid-delay; verify timer resumes correctly.
- **Negative tests:** Operator config below floor rejected. Bypass attempt without admin rejected. Wrong typed-CONFIRM input rejected.
- **Agent-meta-reviewer pre-flight:** Each new specialist agent passes meta-review before merge.
- **Manual smoke:** Real homelab simulating an OOM kill on a Proxmox container; verify proxmox-expert produces a fix plan with reversible destructiveness; gate fires; operator approves; fix applied.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Operator finds typed-CONFIRM annoying and finds a workaround (e.g., env var bypass) | High | Critical -- governance hole | Bypass mechanisms require admin role + are audit-logged. Default config has NO bypass. Documented as intentional friction. |
| 24h delay state file corruption causes pending actions to be lost (silent dropout) | Low | High -- migration scheduled but never fires | State files are HMAC-signed. Corruption rejected on read with operator-visible escalation. Daemon refuses to start if any pending-action file is corrupt. |
| Specialist agent's tool grant (`Bash(pct *)` etc.) is too permissive (e.g., `pct destroy` allowed) | Medium | High -- destructive operation runs without ladder check | Each Bash sub-pattern is reviewed at agent-meta-review time. PLAN-017-2's checklist covers privileged-tool grants. Future hardening: per-command allowlists instead of glob patterns. |
| Backup verification is naive (relies on backup-manifest.json that the operator may forget to update) | High | High -- "fresh backup" claim is wrong | Backup orchestrator can ALSO query the platform's backup tool directly (e.g., `pve-backup status`) for live verification. Configurable per-platform: `verify_via: manifest|live`. Documented best practice. |
| 24h delay defaults are too long for emergency hotfixes | Medium | Medium -- ops slowness | `architectural` actions can be marked `urgent: true` with admin sign-off, reducing delay to 1h. Audit-logged with operator justification. Documented. |
| Migration orchestrator's persistence between phases creates a target for tampering | Low | High -- state mutation by attacker | State files are HMAC-signed. Tampering rejected. Daemon refuses to load a migration with broken HMAC. |

## Definition of Done

- [ ] Destructiveness ladder + FLOOR mapping match TDD §8 verbatim
- [ ] `validateOperatorConfig` rejects below-floor configurations
- [ ] `gateApproval` enforces typed-CONFIRM for data-affecting and dry-run + 24h + CONFIRM for architectural
- [ ] Typed-CONFIRM modal requires literal `CONFIRM` and times out at 60s
- [ ] 24h delay state persists across daemon restarts
- [ ] All seven specialist agents exist and pass agent-meta-reviewer
- [ ] Agent prompts include the destructiveness ladder directive
- [ ] Migration schema validates the TDD §10 example
- [ ] `MigrationOrchestrator` runs through all phases with state persistence
- [ ] Backup verification refuses data-affecting actions without a fresh backup
- [ ] `safety check`, `cancel-action`, `migrations status` CLI subcommands work
- [ ] Unit tests pass with ≥95% coverage
- [ ] Integration test demonstrates end-to-end migration with simulated delay
- [ ] All bypass attempts (config-below-floor, wrong CONFIRM, missing admin) rejected
- [ ] Operator documentation explains the ladder, the safety guarantees, and the override procedures
- [ ] No regressions in PLAN-002-1 functionality
