# SPEC-002-2-03: Seven Specialist Agent Files (proxmox, kubernetes, unraid, unifi, freenas, docker, observability)

## Metadata
- **Parent Plan**: PLAN-002-2 (Destructiveness Ladder Enforcement + Specialist Agents + Migration Framework + Backup Orchestration)
- **Tasks Covered**: Task 6 (author seven specialist agent files per TDD §9)
- **Future Home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-2-03-seven-specialist-agent-files.md`
- **Estimated effort**: 5 hours

## Description
Author the seven specialist subagent definitions per TDD-002 §9 that produce platform-specific fix plans honoring the destructiveness ladder. Each agent is a Markdown file with YAML frontmatter (consumed by Claude Code's plugin loader) and a system prompt that includes the destructiveness ladder verbatim and the non-bypass directive: **"you CANNOT bypass the ladder."**

Tool grants follow the principle of least privilege:
- Read-only agents (`unifi-expert`, `homelab-observability-expert`) get **no Bash** — they query via HTTPS APIs through `Read`/`WebFetch` only.
- Platform agents get **narrow Bash patterns** restricted to that platform's CLI (e.g., `Bash(pct *)` for Proxmox container CLI; `Bash(qm *)` for Proxmox VM CLI).
- All agents get `Read`, `Glob`, `Grep` so they can inspect operator config and existing observation/audit logs.
- No agent gets `Edit`, `Write`, or unrestricted `Bash` — modifications go through the gate, not directly through the agent.

Each agent will be audited by the existing `agent-meta-reviewer` (PLAN-017-2 of autonomous-dev) on registration. The agent-meta-reviewer's tool-restriction checklist must pass for all seven before merge.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/agents/proxmox-expert.md` | Create | LXC + KVM specialist; tools: Read, Glob, Grep, Bash(pct *), Bash(qm *), Bash(pvesh *) |
| `plugins/autonomous-dev-homelab/agents/kubernetes-expert.md` | Create | K8s/K3s specialist; tools: Read, Glob, Grep, Bash(kubectl *), Bash(helm *) |
| `plugins/autonomous-dev-homelab/agents/unraid-expert.md` | Create | Unraid specialist; tools: Read, Glob, Grep, Bash(emhttp *) |
| `plugins/autonomous-dev-homelab/agents/unifi-expert.md` | Create | UniFi specialist; tools: Read, Glob, Grep, WebFetch (no Bash; HTTPS API queries only) |
| `plugins/autonomous-dev-homelab/agents/freenas-expert.md` | Create | TrueNAS / FreeNAS specialist; tools: Read, Glob, Grep, Bash(zpool *), Bash(zfs *) |
| `plugins/autonomous-dev-homelab/agents/docker-expert.md` | Create | Docker / compose specialist; tools: Read, Glob, Grep, Bash(docker *) |
| `plugins/autonomous-dev-homelab/agents/homelab-observability-expert.md` | Create | Read-only analyst; tools: Read, Glob, Grep (no Bash, no WebFetch) |

## Implementation Details

### Common Frontmatter Schema (all 7 files)

```yaml
---
name: <agent-name>                    # e.g., proxmox-expert
version: "1.0.0"
role: specialist
model: "claude-sonnet-4-20250514"     # Sonnet for cost; Opus reserved for architecture-reviewer
temperature: 0.2                      # Low temp for deterministic plan generation
turn_limit: 30
tools:                                # Per-agent allowlist below
  - Read
  - Glob
  - Grep
  # plus narrow Bash patterns per agent (or none for read-only)
expertise:
  - <platform>-operations
  - fault-diagnosis
  - fix-plan-generation
evaluation_rubric:
  - name: ladder-compliance
    weight: 0.40
    description: Fix plan correctly classifies each step's destructiveness; never proposes bypassing the ladder.
  - name: minimal-blast-radius
    weight: 0.30
    description: Proposes the LEAST destructive action that resolves the fault.
  - name: dry-run-quality
    weight: 0.20
    description: Architectural plans include a complete, accurate dry-run report.
  - name: platform-correctness
    weight: 0.10
    description: CLI invocations are syntactically valid for the target platform version.
---
```

### System-Prompt Template (shared body, per-agent details inserted)

Every agent's prompt MUST include this verbatim block (copied identically into each file). Agent-meta-reviewer checks for its presence.

```markdown
# <Agent Display Name>

You are the **<platform>** specialist for the homelab autofix workflow.
Your job is to consume an observation (a fault probe finding) and produce a
**fix plan** that the gate (`gateApproval`) will route through the appropriate
approval flow.

## The Destructiveness Ladder (TDD-002 §8) — YOU CANNOT BYPASS THIS

Every step in your fix plan MUST be classified into exactly one of:

| Level                  | Floor | Approval flow                                        |
| ---------------------- | ----- | ---------------------------------------------------- |
| `read-only`            | L3    | Pass-through                                         |
| `reversible`           | L1    | Standard operator approval (single yes/no)           |
| `persistent-modifying` | L0    | Standard approval at L0                              |
| `data-affecting`       | L0    | Typed-CONFIRM modal + backup verification            |
| `architectural`        | L0    | Dry-run + 24-hour delay + typed-CONFIRM + backup     |

**You CANNOT bypass the ladder.** If the only viable fix requires
`data-affecting` or `architectural` and the operator has not pre-approved
those categories, you MUST halt and emit a `RequiresOperatorEscalation`
result instead of producing a fix plan that tries to evade the gate.

## Output Contract

Emit a JSON document conforming to the FixPlan schema:

```json
{
  "plan_id": "<ulid>",
  "platform": "<your platform>",
  "summary": "<one-sentence description of what this plan does>",
  "observation_id": "<id of the observation that triggered this>",
  "steps": [
    {
      "step_id": 1,
      "destructiveness": "reversible",
      "command": "pct restart 101",
      "rationale": "Container 101 is OOM-killed; restart restores service.",
      "rollback": "pct stop 101 && pct start 101 with prior memory cap",
      "estimated_duration_seconds": 10
    }
  ],
  "requires_backup": false,
  "dry_run_report": null
}
```

For any step at `data-affecting` or `architectural`, you MUST set
`requires_backup: true` and provide a `dry_run_report` (a string describing
exactly what `--dry-run` produced for the platform's tooling).

## Hard Rules

1. NEVER set a step's destructiveness lower than its true blast radius. When
   in doubt, classify UP.
2. NEVER chain steps that smuggle a `data-affecting` change inside a series
   labeled `reversible`. Each step is classified independently.
3. NEVER propose a bypass mechanism (e.g., env vars, sudo, hidden flags).
4. NEVER write or edit files. Your output is the plan; the gate decides what
   runs.
5. If the platform's CLI returns an error you cannot interpret, emit
   `RequiresOperatorEscalation` rather than guessing.
```

### Per-Agent Specifics

#### `proxmox-expert.md`
- Tools: `Read, Glob, Grep, Bash(pct *), Bash(qm *), Bash(pvesh *)`
- Domain section: LXC containers (`pct`), KVM VMs (`qm`), cluster API (`pvesh`).
- Common faults: OOM kills (reversible: `pct restart`), disk full (data-affecting: prune), version drift (architectural: PVE upgrade).
- Example fix plan inline in prompt: an OOM-kill fix at `reversible`.

#### `kubernetes-expert.md`
- Tools: `Read, Glob, Grep, Bash(kubectl *), Bash(helm *)`
- Domain section: Pod/Deployment/StatefulSet, Helm releases, namespace boundaries, RBAC.
- Common faults: CrashLoopBackOff (reversible: `kubectl rollout restart`), PVC full (data-affecting: resize), CRD upgrade (architectural).
- Hard rule emphasis: NEVER propose `kubectl delete pvc` without `data-affecting + backup`.

#### `unraid-expert.md`
- Tools: `Read, Glob, Grep, Bash(emhttp *)`
- Domain section: Unraid array, parity, plugins.
- Note: `emhttp` is Unraid's privileged CLI; the wildcard pattern is broad — agent's prompt explicitly enumerates allowed sub-commands and forbids parity-rebuild without typed-CONFIRM.

#### `unifi-expert.md`
- Tools: `Read, Glob, Grep, WebFetch` — **NO BASH**.
- Domain section: UniFi controller HTTPS API. Read-only by design; produces config-change recommendations as fix plans, not direct commands.
- All proposed steps are `read-only` or escalate to operator for application via the controller UI.

#### `freenas-expert.md`
- Tools: `Read, Glob, Grep, Bash(zpool *), Bash(zfs *)`
- Domain section: ZFS pools, datasets, snapshots, replication.
- Common faults: pool degraded (reversible if hot-spare; data-affecting if resilver), dataset full (reversible: prune snapshots).
- Hard rule: `zpool destroy` and `zfs destroy` are ALWAYS `architectural`.

#### `docker-expert.md`
- Tools: `Read, Glob, Grep, Bash(docker *)`
- Domain section: containers, images, networks, volumes, compose files.
- Common faults: container restart loop (reversible), volume corruption (data-affecting), compose-stack rebuild (persistent-modifying).
- Hard rule: `docker volume rm` requires `data-affecting + backup`. `docker network prune` is `persistent-modifying` (may disrupt active containers).

#### `homelab-observability-expert.md`
- Tools: `Read, Glob, Grep` — **NO BASH, NO WEBFETCH**.
- Domain section: read observation logs, audit logs, metrics dumps; produce dashboards and analyses.
- Output contract differs: emits `AnalysisReport`, not `FixPlan`. Every output is `read-only`. Cannot propose any modifying action — that is delegated to the platform-specific specialist.

## Acceptance Criteria

### Per-File Structural Checks
- [ ] All 7 files exist at `plugins/autonomous-dev-homelab/agents/<name>.md`.
- [ ] Each file's frontmatter parses as valid YAML (verified by frontmatter parser, e.g., `gray-matter`).
- [ ] Each frontmatter has `name`, `version`, `role: specialist`, `model`, `temperature`, `turn_limit`, `tools`, `expertise`, `evaluation_rubric`.
- [ ] Each `name` matches the filename (without `.md`).
- [ ] Each `evaluation_rubric` has `ladder-compliance` with `weight: 0.40`.

### Tool Grant Audit (the load-bearing acceptance criterion)
- [ ] `proxmox-expert` tools: exactly `[Read, Glob, Grep, Bash(pct *), Bash(qm *), Bash(pvesh *)]` — no extras.
- [ ] `kubernetes-expert` tools: exactly `[Read, Glob, Grep, Bash(kubectl *), Bash(helm *)]`.
- [ ] `unraid-expert` tools: exactly `[Read, Glob, Grep, Bash(emhttp *)]`.
- [ ] `unifi-expert` tools: exactly `[Read, Glob, Grep, WebFetch]` — no Bash entries at all.
- [ ] `freenas-expert` tools: exactly `[Read, Glob, Grep, Bash(zpool *), Bash(zfs *)]`.
- [ ] `docker-expert` tools: exactly `[Read, Glob, Grep, Bash(docker *)]`.
- [ ] `homelab-observability-expert` tools: exactly `[Read, Glob, Grep]` — no Bash, no WebFetch.
- [ ] No agent has `Edit`, `Write`, or unrestricted `Bash`. Verified by a test that scans every file's `tools` list.

### Prompt-Body Audit
- [ ] Every prompt body contains the literal string `"You CANNOT bypass the ladder."` (case-sensitive).
- [ ] Every prompt body contains the table header line `"| Level                  | Floor | Approval flow"` (verifies the destructiveness table is present).
- [ ] Every prompt body contains all 5 destructiveness levels: `read-only`, `reversible`, `persistent-modifying`, `data-affecting`, `architectural`.
- [ ] Every prompt body contains the hard rule "NEVER propose a bypass mechanism".
- [ ] Every prompt body contains the output contract example (the JSON FixPlan or AnalysisReport).

### agent-meta-reviewer Pre-flight (manual + automated)
- [ ] All 7 agents pass the `agent-meta-reviewer` checklist (PLAN-017-2 of autonomous-dev) for tool-restriction. Failures block merge.
- [ ] The meta-reviewer's report for each agent is attached to the PR or stored at `plugins/autonomous-dev-homelab/agents/.meta-review-reports/<agent-name>.json`.

### Special Cases
- [ ] `unifi-expert` proposes ONLY `read-only` steps in its example. Any modifying recommendation is in the `description` field, not the `steps` array.
- [ ] `homelab-observability-expert` output schema is `AnalysisReport`, not `FixPlan`; documented in the prompt body.
- [ ] `freenas-expert` prompt explicitly states `zpool destroy` and `zfs destroy` are `architectural`.
- [ ] `docker-expert` prompt explicitly states `docker volume rm` requires `data-affecting + backup`.

## Dependencies

- **TDD-002 §9** — defines the seven agents and their domains.
- **PLAN-017-2 (autonomous-dev)** — provides `agent-meta-reviewer` that audits these agents at registration.
- **SPEC-002-2-01** — agent prompts reference the destructiveness ladder authored there.
- Claude Code plugin loader's agent format (frontmatter schema is contract).

## Notes

- The shared system-prompt template is repeated verbatim across all 7 files rather than refactored into a shared include. This is deliberate: subagents in Claude Code do not support includes, and operators reading any single agent file should see the full ladder without chasing references. The cost is duplicated text; the benefit is auditability and zero coupling between agent files.
- Tool grants are exact-match arrays, not patterns. Adding a tool to one agent does not affect another. If we ever introduce a per-command Bash allowlist (per the plan's risk-register hardening note), each agent's tools list is replaced with the new format individually.
- `unifi-expert` is intentionally read-only because UniFi controller writes are stateful and easy to misapply; recommended changes go through the operator's manual review and the controller UI. A future plan may add a write-capable variant gated by L0 + typed-CONFIRM.
- `homelab-observability-expert` runs at `model: claude-sonnet-4-20250514` (same as others). Observability work is read-heavy; if the cost analysis after the first 30 days shows it warrants Haiku, swap the model in a follow-up patch.
- The `evaluation_rubric` weights in this spec are starting values. After 30 days of production use, rubric weights should be reviewed against operator-flagged plan-quality scores.
- Test files for this spec live under `plugins/autonomous-dev-homelab/tests/agents/test-agent-frontmatter.test.ts` and check the structural assertions above. The substantive prompt-quality assertions are the responsibility of `agent-meta-reviewer`, not unit tests.
