# TDD-002: Observation Loop, Auto-Fix Pipeline & Migration

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Observation Loop, Auto-Fix Pipeline & Migration    |
| **TDD ID**   | TDD-002                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-001: Homelab Platform                        |
| **Plugin**   | autonomous-dev-homelab                             |

---

## 1. Summary

This TDD specifies the homelab observation loop (fault detection across 7 platform types), the auto-fix pipeline integrating with autonomous-dev's normal request flow, the destructiveness ladder enforcement (PRD-001 §25.2 BINDING), specialist agents per platform, migration framework with Portainer→k3s example, backup orchestration, and homelab deploy backends contributed to PRD-014's framework.

Sibling TDD-001 covers discovery + connection layer. This TDD assumes connections are established and focuses on the operations performed through them.

## 2. Goals & Non-Goals

| ID    | Goal                                                                          |
|-------|--------------------------------------------------------------------------------|
| G-01  | Continuous fault detection across 7 platforms with platform-specific probes.  |
| G-02  | Auto-fix pipeline routes faults through autonomous-dev's normal request flow. |
| G-03  | Destructiveness ladder enforcement at framework level (operator cannot bypass). |
| G-04  | 7 specialist agents (one per platform).                                       |
| G-05  | Migration framework: dry-run → 24h delay → typed-CONFIRM → execute → verify.  |
| G-06  | Backup orchestration: restic/BorgBackup with weekly automated restore-tests.  |
| G-07  | Homelab deploy backends contributed to PRD-014: docker, k8s, proxmox-lxc.    |
| G-08  | Zero-data-loss + zero-unintended-destructive metrics as release blockers.     |

| ID     | Non-Goal                                                                |
|--------|--------------------------------------------------------------------------|
| NG-01  | Discovery + connection layer (TDD-001).                                 |
| NG-02  | Replacing autonomous-dev's pipeline (we use it).                        |
| NG-03  | Multi-operator support.                                                 |

## 3. Background

PRD-001 §25.2 establishes a destructiveness ladder. PRD-001 §25.5 establishes safety metrics as release blockers. This TDD operationalizes both — the framework code REJECTS operator config that tries to lower the ladder floor, and CI rejects releases that violate safety metrics.

## 4. Architecture

```
                    ┌──────────────────────────┐
                    │ Per-platform Fault Probes│ (TDD-001 connections)
                    │ • k8s events             │
                    │ • docker stats           │
                    │ • proxmox cluster log    │
                    │ • UniFi events API        │
                    │ • ZFS pool status         │
                    │ • SMART status            │
                    │ • cert expiry checker     │
                    │ • backup-overdue checker  │
                    └────────────┬─────────────┘
                                 │ structured observations
                                 ▼
                    ┌──────────────────────────┐
                    │ Observation Engine        │
                    │ • dedup                   │
                    │ • severity classification │
                    │ • destructiveness category│
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ autonomous-dev Intake    │
                    │ (request type from §11)   │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ Trust Gate                │ ← destructiveness ladder enforcement
                    │ (framework-enforced floor)│
                    └────────────┬─────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────┐
                │ Specialist Agent               │ → fix plan
                │ (proxmox-expert / k8s-expert / │
                │  unraid-expert / unifi-expert /│
                │  freenas-expert / docker-expert/│
                │  homelab-observability-expert)  │
                └────────────┬───────────────────┘
                             │
                             ▼
                ┌─────────────────────────────────┐
                │ autonomous-dev Pipeline + Deploy│
                │ via homelab backends             │
                └─────────────────────────────────┘
```

## 5. Fault Pattern Catalog

| Pattern | Detection | Severity | Default request_type | Destructiveness |
|---------|-----------|----------|----------------------|------------------|
| Container CrashLoopBackOff | k8s events / docker restart count | P1 | bug | reversible |
| OOM kill | k8s events / docker stats / dmesg | P1 | bug | persistent-modifying (raise mem) |
| Disk I/O errors | SMART warnings / dmesg | P0 | infra | data-affecting (replace disk) |
| ZFS pool degraded | `zpool status` non-ONLINE | P0 | infra | data-affecting |
| UniFi AP offline | UniFi events API | P1 | bug | reversible |
| Cert expiry within 7d | x509 issuer scan | P2 | hotfix | reversible |
| Backup overdue >24h | manifest age check | P1 | infra | reversible |
| Service 5xx >5min | HTTP probe | P1 | bug | reversible |
| Daemon heartbeat stale | autonomous-dev daemon | P0 | hotfix | reversible |

## 6. Per-Platform Fault Probes

```typescript
// k8s probe
class K8sProbe {
  constructor(private conn: K8sConnection) {}
  async scan(): Promise<Observation[]> {
    const events = await this.conn.exec(`kubectl get events --field-selector type=Warning -A -o json`);
    return JSON.parse(events.stdout).items
      .filter(e => e.reason === "BackOff" || e.reason === "OOMKilled")
      .map(e => ({
        platform: this.conn.platformId,
        pattern: e.reason === "OOMKilled" ? "oom_kill" : "crash_loop",
        resource: `${e.involvedObject.kind}/${e.involvedObject.name}`,
        severity: "P1",
        details: { count: e.count, message: e.message }
      }));
  }
}

// Docker probe — listens to docker events stream
class DockerProbe {
  async scan(): Promise<Observation[]> {
    const events = await this.conn.exec(`docker events --since 5m --until 0m --filter event=oom --format json`);
    return events.stdout.split("\n").filter(Boolean).map(e => JSON.parse(e)).map(e => ({
      platform: this.conn.platformId,
      pattern: "oom_kill",
      resource: `container/${e.Actor.Attributes.name}`,
      severity: "P1",
      details: e
    }));
  }
}

// Proxmox probe
// UniFi probe
// ZFS probe (via TrueNAS API or direct SSH)
// SMART probe
// ... etc
```

Cadence:
- Fast (5min): k8s, docker, daemon-heartbeat (high-frequency events)
- Medium (15min): Proxmox, Unraid (lower-frequency)
- Slow (1h): cert expiry, backup overdue
- Daily: full SMART scan, ZFS scrub status

## 7. Observation → Request Promotion

```typescript
async function promoteObservation(obs: Observation): Promise<void> {
  const dedupKey = `${obs.platform}:${obs.pattern}:${obs.resource}`;
  if (await recentObservation(dedupKey, "1h")) return;  // dedup

  const requestType = mapToRequestType(obs);  // bug/infra/hotfix per fault catalog
  const destructiveness = mapToDestructiveness(obs);  // see §8 ladder

  // Submit to autonomous-dev intake (uses CLI bridge from PRD-008)
  await execFile("autonomous-dev", [
    "request", "submit",
    "--type", requestType,
    "--source", "production-intelligence",
    "--repo", obs.targetRepo || "homelab",
    "--description", buildBugReport(obs),
    "--metadata", JSON.stringify({ destructiveness, observation_id: obs.id })
  ]);
}
```

## 8. Destructiveness Ladder Enforcement

```typescript
type Destructiveness = "read-only" | "reversible" | "persistent-modifying" | "data-affecting" | "architectural";

const FLOOR: Record<Destructiveness, TrustLevel> = {
  "read-only": TrustLevel.L3,           // L3 OK
  "reversible": TrustLevel.L1,           // L1 (operator approval per request)
  "persistent-modifying": TrustLevel.L0, // L0 (approval at every gate)
  "data-affecting": TrustLevel.L0,       // L0 + typed-CONFIRM modal
  "architectural": TrustLevel.L0         // L0 + dry-run + 24h delay + typed-CONFIRM
};

function validateOperatorConfig(config: OperatorConfig): void {
  for (const [destructiveness, configuredTrust] of Object.entries(config.auto_approval)) {
    const requiredFloor = FLOOR[destructiveness];
    if (configuredTrust < requiredFloor) {
      throw new ConfigurationError(
        `Cannot configure auto-approval for ${destructiveness} below required floor ${requiredFloor}. ` +
        `This is enforced at the framework level and cannot be overridden.`
      );
    }
  }
}

async function gateApproval(action: Action): Promise<ApprovalResult> {
  const dest = action.destructiveness;
  const floor = FLOOR[dest];

  if (action.trust_level < floor) {
    return { approved: false, reason: `Trust level ${action.trust_level} below floor ${floor} for ${dest}` };
  }

  if (dest === "data-affecting") {
    const confirmed = await typedConfirmModal({
      message: `This is a DATA-AFFECTING operation: ${action.description}. Type CONFIRM to proceed.`,
      ttl_seconds: 60
    });
    if (!confirmed) return { approved: false, reason: "typed-CONFIRM not provided" };
  }

  if (dest === "architectural") {
    const dryRun = await action.dryRun();
    await waitDelay(24 * 3600);  // 24h delay
    const confirmed = await typedConfirmModal({ message: `Architectural change. Dry-run report: ${dryRun}. Type CONFIRM.` });
    if (!confirmed) return { approved: false, reason: "typed-CONFIRM not provided after 24h delay" };
  }

  return { approved: true };
}
```

## 9. Specialist Agents

Each agent file at `plugins/autonomous-dev-homelab/agents/<name>.md`. Example:

```markdown
---
name: proxmox-expert
description: Proxmox VE specialist — diagnoses cluster, container, VM, and storage issues; produces fix plans honoring destructiveness ladder.
model: claude-sonnet-4-6
tools: Read, Glob, Grep, Bash(pct *), Bash(qm *), Bash(pvesh *)
---

You are a Proxmox VE expert. Given a homelab observation about a Proxmox cluster, produce a fix plan.

For each fix, specify:
1. Destructiveness category (read-only / reversible / persistent-modifying / data-affecting / architectural)
2. Required trust level (per the ladder — framework will reject if you violate)
3. Concrete commands (pct, qm, pvesh)
4. Rollback steps for reversible operations
5. Dry-run for data-affecting+

You CANNOT bypass the destructiveness ladder. If the only fix requires data-affecting + L0 approval and the operator hasn't pre-approved, halt and report.

Common fault patterns you handle:
- Container OOM: increase memory in pct config (reversible)
- VM disk full: extend disk via qm resize (data-affecting requires CONFIRM)
- Cluster quorum loss: rejoin node (architectural — full plan required)
- Storage pool degraded: replace disk procedure (data-affecting)
```

Similar agents: kubernetes-expert, unraid-expert, unifi-expert, freenas-expert, docker-expert, homelab-observability-expert.

## 10. Migration Framework

Migration plan schema:

```yaml
migration_id: PORTAINER-TO-K3S-2026-04-28
source_platform: portainer-01
target_platform: k3s-01
classification: architectural    # always — migrations are L0
phases:
  - name: identify-resources
    actions:
      - list_containers_via_portainer
      - extract_compose_definitions
      - identify_volumes_and_persistent_data
  - name: plan-target
    actions:
      - generate_k8s_manifests_from_compose
      - plan_namespace_layout
      - plan_persistent_volume_claims
  - name: dry-run
    actions:
      - apply_to_test_cluster
      - verify_health_endpoints
      - report_to_operator
  - name: approval-delay
    duration: 24h
    requires_typed_confirm: true
  - name: execute
    actions:
      - provision_pvcs_with_data_copy
      - apply_manifests_to_target
      - wait_for_ready
      - cutover_dns
      - verify_traffic
      - decommission_portainer_containers
  - name: verify
    actions:
      - smoke_test_each_service
      - confirm_no_data_loss
rollback:
  - restore_dns
  - restart_portainer_containers
  - report_failure
```

Migration execution gated by destructiveness ladder + per-phase approval.

## 11. Backup Orchestration

```typescript
interface BackupConfig {
  tool: "restic" | "borg";
  source: { platform: string; volumes: string[] } | { platform: string; database: string; databaseType: "postgresql" | "mysql" };
  target: { repository: string; passwordFile: string };
  schedule: string;       // cron expression
  retention: { hourly: number; daily: number; weekly: number; monthly: number };
  verification: { method: "integrity-check" | "restore-test"; cadence: string };
}

class BackupExecutor {
  async runJob(config: BackupConfig): Promise<BackupResult> {
    if (config.source.volumes) return this.backupVolumes(config);
    if (config.source.databaseType) return this.backupDatabase(config);
  }

  async runVerification(config: BackupConfig): Promise<VerificationResult> {
    if (config.verification.method === "restore-test") return this.performRestoreTest(config);
    return this.performIntegrityCheck(config);
  }
}
```

Restore-test runs weekly: restore latest backup to a temp location, verify file count + sample integrity, alert if failure.

## 12. Homelab Deploy Backends

Three backends contributed to PRD-014's framework:

```typescript
class HomelabDockerBackend implements DeploymentBackend {
  name = "homelab-docker";
  async build(ctx) { /* docker build via TDD-001 DockerConnection */ }
  async deploy(artifact, env) { /* docker run with health probe */ }
  async healthCheck(d) { /* docker inspect + http probe */ }
  async rollback(d) { /* docker stop + redeploy previous image */ }
}

class HomelabK8sBackend implements DeploymentBackend {
  name = "homelab-k8s";
  async build(ctx) { /* kubectl apply with manifests */ }
  async deploy(artifact, env) { /* helm or kubectl with rollout-status wait */ }
  // ...
}

class HomelabProxmoxLxcBackend implements DeploymentBackend {
  name = "homelab-proxmox-lxc";
  async build(ctx) { /* select LXC template */ }
  async deploy(artifact, env) { /* pct create + pct start + ip detection */ }
  // ...
}
```

## 13. Portal Integration

Adds homelab pages to autonomous-dev-portal (PRD-009) via the cross-plugin `skill-content-extension` hook (homelab PRD §25.7):

- `/homelab` — overview: platforms, recent observations, active fixes, backup status
- `/homelab/platforms` — inventory + connection health
- `/homelab/observations` — fault timeline
- `/homelab/migrations` — in-flight + completed migrations
- `/homelab/backups` — schedule + last-success + restore-test results

## 14. Audit & Safety Metrics

| Metric | Target | Action on violation |
|--------|--------|---------------------|
| Zero data-loss incidents | 0 per release | BLOCK release |
| Zero unintended destructive operations | 0 per release | BLOCK release |
| Migration safety: 100% include dry-run + approval | 100% | BLOCK release |
| Backup verification weekly success | >95% | Page operator |
| Auto-fix success rate | >70% | Investigate downward trend |
| Observation→fix MTTR (P1) | <60min | Investigate upward trend |

CI workflow checks these metrics against persisted release records before tagging.

## 15. Test Strategy

- Per-platform fault injection: 5+ scenarios per platform with synthetic faults; verify probe detects, observation produced, destructiveness category correct
- Destructiveness ladder enforcement: try to lower the floor in config (must reject); try to bypass typed-CONFIRM (must reject); try to skip 24h delay for architectural (must reject)
- Specialist agent fixture corpus: 10+ historical bugs per agent with known good fix plans; test agent precision
- Migration dry-run: toy Portainer→k3s on disposable test cluster
- Backup→restore round-trip: per backup config, verify restored data matches source

## 16. Performance

- Observation cadence vs API rate limits: per-platform table; never exceed 50% of rate limit
- Fix pipeline latency target: <60min MTTR for P1, <4h for P2
- Migration timeline: depends on data volume; 1-week typical for medium-sized migration

## 17. Migration & Rollout

- Phase 1 (Weeks 1-3): Read-only observation; no auto-fix
- Phase 2 (Weeks 4-6): Reversible auto-fix only (L1 default)
- Phase 3 (Weeks 7-9): Persistent-modifying with strict L0 approvals
- Phase 4 (Weeks 10-15): Architectural migration capability with dry-run gate

## 18. Open Questions

1. Multi-cluster k8s: per-cluster expert agents or shared?
2. Backup encryption key rotation: how distributed across targets?
3. Network segmentation: probe across VLANs requires multi-CIDR consent
4. Resource quotas per platform for autonomous ops (avoid runaway)
5. Integration with existing Prometheus/Grafana?

## 19. References

- Homelab PRD-001 §25 (BINDING): destructiveness ladder, safety metrics, network consent, SSH cert isolation, MCP-availability matrix
- TDD-001 (sibling — connection layer this TDD consumes)
- autonomous-dev PRD-005 (observation→PRD pattern)
- autonomous-dev PRD-007 (trust ladder L0-L3)
- autonomous-dev PRD-011 (request types)
- autonomous-dev PRD-014 (DeploymentBackend interface — homelab contributes)
- autonomous-dev TDD-024 (deploy framework integration)
