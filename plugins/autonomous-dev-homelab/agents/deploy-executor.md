# Deploy Executor — Target Handoff Contract

**Spec issues: #665 (target handoff), #666 (stateful contract), #667 (secret binding)**

This document defines the handoff contract between the autonomous-dev core
orchestrator and the homelab plugin's approval/safety gate for homelab-bound
deploys.

## Overview

When `orchestrateContractDeploy` resolves a target with `location: 'homelab'`,
it calls the injected `dispatchHomelab` function and passes a
`HomelabDispatchContext`. Core does **not** reimplement the plugin's gate —
it delegates entirely.

```
Core orchestrator
  └─ evaluateStatefulPrecondition()         # #666 precondition check
  └─ orchestrateContractDeploy()            # #665 location branch
        │
        ├─ location === 'cloud'  → dispatchCloud(CloudDispatchContext)
        │
        └─ location === 'homelab' → dispatchHomelab(HomelabDispatchContext)
                                         │
                                         └─ [PLUGIN GATE — not in core]
                                              typed-CONFIRM
                                              24h delay
                                              mutation barrier
```

## HomelabDispatchContext (passed to `dispatchHomelab`)

```typescript
interface HomelabDispatchContext {
  request: DeployContractRequest;   // full validated request
  backup_class: BackupClass;        // resolved from target (#666)
  verifiedBackupRef?: string;       // if backup was pre-verified (#666)
  overrideApplied: boolean;         // true when backupOverride=true was used
}
```

Source: `src/deploy/contract-orchestrator.ts`.

## DeployContractRequest fields consumed by the gate

| Field | Description |
|---|---|
| `requestId` | ULID identifying this deploy request |
| `envName` | Target environment label (`prod`, `staging`, …) |
| `commitSha` | Git commit SHA being deployed |
| `target.id` | Opaque target identifier (for audit; not for branching) |
| `target.location` | Always `'homelab'` on this path |
| `target.capabilities` | Capability flags — `'stateful'` triggers backup precondition |
| `target.backup_class` | `'none' | 'snapshot' | 'orchestrated'` (#666) |
| `target.tags` | Role/attribute tags (e.g. `'role:database'`); invariant #674 |
| `requiresVerifiedBackup` | Core has already checked this; gate may enforce the actual backup |
| `backupOverride` | Admin-level bypass; gate must record this in audit trail |
| `verifiedBackupRef` | Pre-verified backup manifest id; gate may skip re-verification |

## Plugin Gate Responsibilities

Core checks the **precondition flag** (`requiresVerifiedBackup` / `backup_class`).
The plugin gate is responsible for:

1. **typed-CONFIRM** — operator must type a confirmation phrase before the
   deploy proceeds (SPEC-002-2-03).
2. **24h delay** — architectural changes impose a 24h hold (SPEC-002-2-02).
3. **Mutation barrier** — prevents concurrent conflicting deploys
   (`src/safety/mutation-barrier.ts`).
4. **Actual backup verification** — for stateful targets the gate calls
   `verifyBackup` from `src/backup/orchestrator.ts` using the `backup_class`
   to select the right verification path.

Core intentionally does **not** replicate any of the above.

## Secret Bindings (#667)

Secret bindings declared in `DeployContractRequest` are resolved JIT via
`resolveSecretBindings()` (see `src/deploy/secret-binding.ts`) **before**
`dispatchHomelab` is called. The context passed to `dispatchHomelab` carries
only `recordSafeBindings` (hash-only projections) — never live secret values.

Live resolved bindings (with secret material) are consumed in-process for
injection and then discarded. They never appear in the `HomelabDispatchContext`
or in the `DeploymentRecord`.

## DeploymentRecord new fields (#665)

`DeploymentRecordPayload` gained three optional fields in issue #665:

| Field | Type | Description |
|---|---|---|
| `targetId` | `string?` | Opaque target id from `ResolvedContractTarget.id` |
| `location` | `'cloud' | 'homelab'?` | Dispatch path used |
| `node` | `string?` | Node within the topology; never a hard-coded name (#674) |

All three fields are covered by the existing HMAC signature in
`sign-record.ts` (via `signPayload` over the canonical payload). Tampering
with any of the three fields after signing is detected by `verifyDeploymentRecord`.

## Invariant #674 Compliance

All branching in core (orchestrator, selector, precondition check) uses:
- `target.location` — `'cloud' | 'homelab'`
- `target.capabilities` — `['stateful', ...]`
- `target.tags` — `['role:database', ...]`
- `target.backup_class` — `'none' | 'snapshot' | 'orchestrated'`

**Never:** instance ids, service names, node names, or IP addresses in branching
logic. The `target.id` and `node` fields in `DeploymentRecord` are for audit
and correlation only.
