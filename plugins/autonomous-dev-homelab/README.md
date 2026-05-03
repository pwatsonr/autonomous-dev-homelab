# autonomous-dev-homelab (plugin)

Homelab platform discovery, connection, observation, safety-gated autofix,
migration, and deployment for the [`autonomous-dev`](https://github.com/pwatson/autonomous-dev)
ecosystem. Implements [PRD-001](../../docs/prd/PRD-001-homelab-platform.md),
[TDD-001](../../docs/tdd/TDD-001-platform-discovery-connection.md), and
[TDD-002](../../docs/tdd/TDD-002-observation-autofix-migration.md).

## What it does

Seven cross-cutting capabilities, each spec-driven and tested end-to-end.

### 1. Platform discovery (TDD-001 §5–7)

Probes a consented CIDR range for **7 platform types**: Proxmox VE,
Kubernetes / k3s, Docker (incl. Swarm), Unraid, TrueNAS, UniFi controllers, and
generic Linux hosts. Each platform has an HTTP/HTTPS fingerprint (port + path +
expected response signature) in `src/discovery/fingerprints.ts`. Discovered
hosts are written to a versioned, atomically-persisted inventory at
`<homelab-data>/inventory.yaml` and validated against
`schemas/inventory-v1.json`.

Network scanning is **gated by an explicit, OS-aware consent record**
(`<homelab-data>/network_consent.yaml`, `schemas/network-consent-v1.json`)
with TTL, permitted ports, scan types, and a network-fingerprint binding so a
consent granted on one network can't be silently reused on another (SEC-007).

### 2. Connection layer (TDD-001 §8–11)

Per-platform `Connection` subclasses with a uniform `connect / exec /
disconnect` contract. Connection priority:

1. **MCP server** when discoverable in `.mcp.json`
   (`mcp-server-proxmox`, `mcp-server-kubernetes`, `mcp-server-docker`, etc.).
2. **SSH** with certificate auth from a per-plugin SSH CA (`src/ca/manager.ts`),
   per-platform key isolation (SEC-009), encrypted CA passphrase storage with
   `HOMELAB_CA_PASSPHRASE` override, and a generated KRL for revocation.
3. **HTTPS bearer-token / API key** for platforms with no SSH (UniFi).

Connections are pooled (`src/connection/pool.ts`) with idle-TTL eviction and
dedup-by-platform-id.

### 3. Observation loop (TDD-002 §5–7)

A typed catalog of 9 fault patterns (`src/observation/fault-catalog.ts`) and 9
matching probes:

| Probe | Source | Detects |
|---|---|---|
| `K8sProbe` | `kubectl get events -A -o json` | CrashLoopBackOff, OOMKilled, ImagePullBackOff, evicted pods |
| `DockerProbe` | `docker events` stream | OOMKilled, container exits, restart loops |
| `ProxmoxProbe` | `pvesh get /cluster/status` | node-down, storage degraded, quorum loss |
| `UnifiProbe` | UniFi events HTTPS API | AP offline, multi-AP outage, RF issues |
| `ZFSProbe` | `zpool status` | DEGRADED / FAULTED pools, scrub errors |
| `SMARTProbe` | `smartctl --all` | reallocated / pending sectors, disk failure trend |
| `CertExpiryProbe` | TLS x509 inspection | certs expiring within 30 days |
| `BackupOverdueProbe` | manifest mtime + freshness rules | overdue backups per platform |
| `DaemonHeartbeatProbe` | heartbeat-file mtime | stalled / dead daemon |

`ObservationCollector` schedules probes, runs them on cadence, dedupes via a
1h disk-backed cache, and persists JSON observations atomically.
`ObservationPromoter` maps fault → request type and invokes the
`autonomous-dev` intake CLI to file a request (bug / infra / hotfix).

### 4. Safety gate (TDD-002 §8)

Every action is classified into a 5-rung **destructiveness ladder**:

```
read-only → reversible → persistent-modifying → data-affecting → architectural
```

`OperatorConfig` declares the trust level for each rung; the validator enforces
a hard **FLOOR** so a config that auto-approves data-affecting / architectural
ops is rejected at load time (SEC-008). The gate routes by destructiveness:

- `read-only` / `reversible` → trust-level check only.
- `data-affecting` → **typed-CONFIRM modal** (`src/safety/typed-confirm.ts`):
  operator must type the action's CONFIRM token within a TTL; bypass attempts
  emit a `bypass-attempt` metric.
- `architectural` → typed-CONFIRM **plus a 24h cooling-off delay**
  (`src/safety/delay.ts`) with HMAC-signed pending-action records
  (`HOMELAB_HMAC_SECRET`) so a tampered or restart-corrupted record is
  rejected.
- `data-affecting` / `architectural` also trigger a **backup verification**
  (`src/backup/orchestrator.ts`) against per-platform freshness rules.

Cancel any pending action via `homelab cancel-action <id>`.

### 5. Specialist agents (TDD-002 §9)

Seven platform-expert agent files in `agents/`, each with platform-scoped
tools (allow-list `Bash` patterns, no broad shell access):

- `proxmox-expert` (LXC + KVM): `Bash(pct *)`, `Bash(qm *)`, `Bash(pvesh *)`
- `kubernetes-expert` (k8s + k3s): `Bash(kubectl *)`, `Bash(helm *)`
- `unraid-expert`: `Bash(emhttp *)`
- `unifi-expert` (no Bash; HTTPS API only): `WebFetch`
- `freenas-expert` (TrueNAS / FreeNAS): `Bash(zpool *)`, `Bash(zfs *)`
- `docker-expert`: `Bash(docker *)`
- `homelab-observability-expert` (read-only analyst): no `Bash`, no `WebFetch`

### 6. Migration framework (TDD-002 §10–11)

`MigrationOrchestrator` runs phased migrations with HMAC-signed state at
`<homelab-data>/migrations/<id>.json`:

```
plan → backup → execute → verify → cutover → rollback (on failure)
```

JSON Schema (`schemas/migration-v1.json`) validates plans; a TDD §10
example fixture is exercised by tests. Backup orchestration verifies fresh,
HMAC-tagged manifests before any data-affecting or architectural step (or
admin-bypass via `--skip-backup-check`).

### 7. Deploy backends + portal (TDD-002 §12–14)

Four homelab `DeploymentBackend` implementations registered with
`autonomous-dev`'s deploy registry:

- `homelab-proxmox` — `pct create` / `qm create` for LXC + KVM
- `homelab-unraid` — `emhttp` HTTP API for Unraid Docker containers
- `homelab-docker-swarm` — `docker stack deploy` with rollback
- `homelab-k3s` — extends the upstream `K8sBackend` with homelab defaults +
  `CredentialProxy`-acquired 15-min scoped kubeconfigs

Portal panel at `/portal/homelab` (`src/portal/homelab-panel.ts`) renders
inventory, observations, pending actions, migrations, and an audit tail with
**SSE live updates**. Four safety metrics emitted to the portal pipeline
(`src/metrics/emitters.ts`):

| Metric | Source |
|---|---|
| `mttr` | observation → request → completion clock |
| `false-positive-rate` | observations cancelled before promotion |
| `gate-latency` | safety gate fire → completion |
| `bypass-attempt` | wrong-CONFIRM input or below-floor config |

A Grafana dashboard JSON ships in `dashboards/homelab.json`.

## CLI surface

Run `node dist/cli/index.js --help` after build, or `npx tsx src/cli/index.ts`
for development. Subcommands:

| Command | Purpose | Admin? |
|---|---|---|
| `discover [--cidr <cidr>] [--json] [--no-prompt]` | Probe consented CIDRs and write to inventory | no |
| `inventory list [--type <plat>] [--json]` | List discovered platforms | no |
| `inventory get <id> [--json]` | Print one platform record | no |
| `inventory remove <id> [--yes] [--json]` | Revoke cert + drop record | **yes** |
| `platform install-ca <id>` | Print `sshd_config` snippet + CA pubkey | yes |
| `platform connect-test <id>` | Open connection, run `whoami`, report transport | yes |
| `platform rotate-key <id>` | Rotate platform's SSH cert | yes |
| `platform exec <id> -- <cmd…>` | Execute a command on a platform | yes |
| `audit verify` | Verify HMAC chain integrity | no |
| `audit query [--type ...] [--since ...]` | Filtered audit-log read | no |
| `consent list / grant / revoke` | Manage network-scan consent | revoke=yes |
| `ca init / rotate / list` | Plugin SSH CA lifecycle | init+rotate=yes |
| `observe scan / list / promote` | Run probes, list observations, promote to requests | no |
| `safety check <action-id>` | Inspect a pending action's gate state | no |
| `cancel-action <id>` | Cancel a pending delayed action | no |
| `migrations status [--id <id>]` | Migration progress + phase | no |
| `metrics show [--metric ...] [--json]` | Print latest safety metric values | no |
| `portal` | Open the homelab panel in a browser | no |

Admin enforcement (`src/cli/middleware/admin-auth.ts`) checks
`HOMELAB_ADMIN_TOKEN` (any non-empty value) **or** OS user membership.

## Configuration

All state defaults to `<homelab-data>` (resolved in priority order:
`HOMELAB_DATA_DIR` → `CLAUDE_PLUGIN_DATA` → `<cwd>/.homelab-data`; the CLI
also accepts `--data-dir` and `AUTONOMOUS_DEV_HOMELAB_DATA_DIR`).

| Env var | Purpose | Default |
|---|---|---|
| `HOMELAB_DATA_DIR` | State directory (consent, inventory, audit log, observations, pending actions, metrics, migrations, CA) | `<cwd>/.homelab-data` |
| `CLAUDE_PLUGIN_DATA` | Fallback for state directory (autonomous-dev convention) | unset |
| `AUTONOMOUS_DEV_HOMELAB_DATA_DIR` | CLI override for state directory | unset |
| `HOMELAB_HMAC_SECRET` | HMAC key for safety / migration / deploy record signing — **required for any data-affecting or architectural op** | unset |
| `HOMELAB_ADMIN_TOKEN` | Any non-empty value grants admin role to the running CLI | unset |
| `HOMELAB_ACTOR` | Override for the audit-log actor field (otherwise `$USER` / `$LOGNAME`) | `$USER` |
| `HOMELAB_CA_PASSPHRASE` | Required for `ca rotate` (and any non-interactive CA op) | unset |
| `HOMELAB_DISABLE_MCP_DISCOVERY` | Set to `1` to skip `.mcp.json` lookup (forces SSH path) | `0` |
| `HOMELAB_PORTAL_BASE_URL` | Base URL the `portal` command opens | `http://localhost:3000` |
| `AUTONOMOUS_DEV_HOMELAB_NETWORK_FINGERPRINT_OVERRIDE` | Override the gateway+DNS fingerprint (test-only escape hatch for SEC-007) | unset |

Note: the audit log HMAC key is **file-based**, not env-based: it lives at
`<homelab-data>/.audit-key` (mode `0600`, generated on first use). See
`src/audit/key-store.ts`.

## Architecture

```
                      +-------------------+
                      |  CLI (commander)  |
                      |   src/cli/*.ts    |
                      +---------+---------+
                                |
   +----------------------------+----------------------------+
   |                            |                            |
   v                            v                            v
+---------+              +-------------+               +----------+
| consent |              |  discovery  |               |  audit   |
|  + CA   |              |  + prober   |               | (HMAC    |
|         |              |  + invty    |               |  chain)  |
+----+----+              +------+------+               +----+-----+
     |                          |                           ^
     |                          v                           |
     |                   +--------------+                   |
     +------------------>|  connection  |<------------------+
                         |   layer      |   (every action emits an audit
                         |  (MCP→SSH→   |    entry; chain is verified by
                         |   HTTPS pool)|    `audit verify`)
                         +------+-------+
                                |
                                v
                         +--------------+      +-----------------+
                         | observation  |      |  fault catalog  |
                         |  (9 probes,  |<-----|   (9 patterns)  |
                         |   collector, |      +-----------------+
                         |   promoter,  |
                         |   dedup)     |
                         +------+-------+
                                |
                                v promotes to request
                         +--------------+
                         |  safety gate |   destructiveness ladder
                         | (typed-CONF, |   read-only → reversible →
                         |  24h delay,  |   persistent → data-affecting →
                         |  HMAC pend.) |   architectural
                         +------+-------+
                                |
                  +-------------+-------------+
                  v                           v
            +-----------+              +--------------+
            | migration |              |    deploy    |
            |  (phased, |              |   backends   |
            |  HMAC st) |              | proxmox /    |
            +-----------+              | unraid /     |
                  |                    | swarm / k3s  |
                  |                    +-------+------+
                  +------------+---------------+
                               v
                         +-----------+
                         |  metrics  |
                         | + portal  |
                         |  (SSE)    |
                         +-----------+
```

State on disk under `<homelab-data>`:

```
<homelab-data>/
  network_consent.yaml         # consent records (TDD-001 §5)
  inventory.yaml               # discovered platforms (TDD-001 §7)
  audit.log                    # HMAC-chained, append-only
  .audit-key                   # 32-byte audit HMAC key, mode 0600
  ca/
    homelab_ca                 # encrypted CA private key
    homelab_ca.pub             # CA public key for distribution
    homelab_ca.krl             # Key Revocation List
  observations/<id>.json       # one file per observation
  pending-actions/<id>.json    # HMAC-signed delayed actions
  migrations/<id>.json         # HMAC-signed migration state
  metrics-clocks/<id>.json     # in-flight MTTR / gate-latency clocks
```

## Tests

```
Test Suites: 4 skipped, 65 passed, 65 of 69 total
Tests:       37 skipped, 697 passed, 734 total
```

Run unit + integration:

```bash
npx jest
```

Run typecheck:

```bash
npx tsc --noEmit
```

Skipped tests (37) require external runtimes opted in via env:
- `kind` cluster (k8s integration probe test)
- A real OpenSSH container (cert-auth + revocation integration)
- A live `autonomous-dev` intake CLI (operator-workflow end-to-end)
- The portal HTTP server (deploy-homelab integration)

## Specialist agents

The `agents/` directory ships seven platform-expert subagent files. They're
picked up automatically by the agent loader when this plugin is installed:

- [`proxmox-expert.md`](agents/proxmox-expert.md)
- [`kubernetes-expert.md`](agents/kubernetes-expert.md)
- [`unraid-expert.md`](agents/unraid-expert.md)
- [`unifi-expert.md`](agents/unifi-expert.md)
- [`freenas-expert.md`](agents/freenas-expert.md)
- [`docker-expert.md`](agents/docker-expert.md)
- [`homelab-observability-expert.md`](agents/homelab-observability-expert.md)

## References

- PRD: [`docs/prd/PRD-001-homelab-platform.md`](../../docs/prd/PRD-001-homelab-platform.md)
- TDD-001: [`docs/tdd/TDD-001-platform-discovery-connection.md`](../../docs/tdd/TDD-001-platform-discovery-connection.md)
- TDD-002: [`docs/tdd/TDD-002-observation-autofix-migration.md`](../../docs/tdd/TDD-002-observation-autofix-migration.md)
- 6 plans: [`docs/plans/`](../../docs/plans/)
- 29 specs: [`docs/specs/`](../../docs/specs/)
