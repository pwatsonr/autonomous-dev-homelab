# Operator Runbook: autonomous-dev-homelab Plugin
## REQ-000055 — Live Homelab End-to-End

| Field | Value |
|---|---|
| **Version** | 0.2.0 |
| **Date** | 2026-07-01 |
| **Author** | REQ-000055 Executor |
| **Owner** | Patrick Watson (pwatsonr@gmail.com) |

---

## 1. Prerequisites

Before using the plugin against the live homelab, ensure the following are met:

### 1.1 Network Reachability
- `gallifrey-lab-01` (Docker Swarm manager) — SSH port 22 reachable from your workstation.
- `gallifrey-lab-02` (Docker Swarm worker) — SSH port 22 reachable.
- `unraid.pwatson.space` — SSH port 22 reachable.
- `vault.pwatson.space:8200` — HTTPS reachable from your workstation.

### 1.2 Software
- Node.js ≥ 20.0.0
- npm ≥ 9.0.0
- Claude Code installed (`~/.claude/` directory exists)
- SSH client (`ssh` command available)

### 1.3 HashiCorp Vault
- Vault is running and reachable at `https://vault.pwatson.space:8200`.
- AppRole credentials are provisioned with read access to `kv/data/homelab/ssh`.
- Environment variables ready:
  - `VAULT_ROLE_ID` — AppRole Role ID
  - `VAULT_SECRET_ID` — AppRole Secret ID

---

## 2. Install

```bash
# Download the tarball (from GitHub Releases or build locally)
bash scripts/package.sh
ls dist/autonomous-dev-homelab-0.2.0.tgz

# Install to ~/.claude/plugins/
bash scripts/deploy/install.sh dist/autonomous-dev-homelab-0.2.0.tgz
```

This installs the plugin to `~/.claude/plugins/autonomous-dev-homelab-0.2.0/` and creates a symlink at `~/.claude/plugins/autonomous-dev-homelab`.

Verify installation:
```bash
~/.claude/plugins/autonomous-dev-homelab/dist/cli/main.js --help
```

---

## 3. Configure

Create the homelab configuration file at `~/.autonomous-dev-homelab/homelab.config.yaml`:

```bash
mkdir -p ~/.autonomous-dev-homelab
```

```yaml
# ~/.autonomous-dev-homelab/homelab.config.yaml
version: 1
vault:
  address: https://vault.pwatson.space:8200
  auth_method: approle
  approle:
    role_id_env: VAULT_ROLE_ID
    secret_id_env: VAULT_SECRET_ID

hosts:
  - hostname: gallifrey-lab-01
    platform: docker-swarm-manager
    role: manager
    ssh_fallback:
      host: gallifrey-lab-01
      port: 22
      user: patrick
      key_ref:
        vault_path: kv/data/homelab/ssh
        vault_field: gallifrey_key

  - hostname: gallifrey-lab-02
    platform: docker-swarm-worker
    role: worker
    ssh_fallback:
      host: gallifrey-lab-02
      port: 22
      user: patrick
      key_ref:
        vault_path: kv/data/homelab/ssh
        vault_field: gallifrey_key

  - hostname: unraid.pwatson.space
    platform: unraid
    role: nas
    ssh_fallback:
      host: unraid.pwatson.space
      port: 22
      user: root
      key_ref:
        vault_path: kv/data/homelab/ssh
        vault_field: tower_key
```

**Security rules:**
- Never put raw key material in this file. Use `vault_path` + `vault_field` only.
- File permissions should be `600`: `chmod 600 ~/.autonomous-dev-homelab/homelab.config.yaml`.

Validate the config:
```bash
homelab config validate
# Expected: "Config is valid."
```

---

## 4. Vault Auth (AppRole)

AppRole is the operator default. Set environment variables before running any live command:

```bash
export VAULT_ROLE_ID="<your-approle-role-id>"
export VAULT_SECRET_ID="<your-approle-secret-id>"
```

Test Vault reachability:
```bash
homelab vault ping
# Expected: "Vault is reachable at https://vault.pwatson.space:8200"
# Exit 0 on success; exit 20 if unreachable; exit 21 if auth fails.
```

**Security note:** Never put `VAULT_ROLE_ID` or `VAULT_SECRET_ID` in shell history or config files. Use a secrets manager or `direnv` with a `.envrc` outside the repo.

---

## 5. Discover / Connect --test / Observe Scan

### 5.1 Discover
```bash
homelab discover --json
# Probes declared hosts, fingerprints platforms, writes inventory.yaml
# Exit 0 on success; exit 30 on platform mismatch.
```

### 5.2 Connect Test
```bash
homelab connect test
# Tests MCP/SSH connectivity to all configured hosts.
# Emits per-host result table and writes audit events.
# Exit 0 iff all hosts pass; exit 31 if any fail.

homelab connect test --host gallifrey-lab-01
# Test a single host.

homelab connect test --json
# Emit JSON output for scripting.
```

Expected output:
```
host                  transport  outcome  latency_ms  error
gallifrey-lab-01      ssh        ok       87
gallifrey-lab-02      ssh        ok       92
unraid.pwatson.space  ssh        ok       110
```

### 5.3 Observe Scan
```bash
homelab observe scan
# Runs probes against all hosts and persists observations.
# Docker Swarm hosts: swarm-container-health probe.
# Unraid host: unraid-array-health + unraid-pool-health probes.

homelab observe list
# List recent observations.
```

---

## 6. Dry-Run Autofix (with --abort-pending demonstration)

The safety model prevents live L0 mutations. All autofix for REQ-000055 is dry-run only.

### 6.1 Propose

```bash
homelab autofix propose <observation-id>
# Writes a Proposal JSON to ~/.autonomous-dev-homelab/.autonomous-dev/proposals/<id>.json
# Output: {"proposal_id":"prop-2026-07-01-abcd","status":"proposed"}
```

### 6.2 Dry-Run

```bash
homelab autofix dry-run <proposal-id>
# Prints gate decision without mutating any host.
# Output example:
#   {"proposal_id":"prop-2026-07-01-abcd","gate_outcome":"WOULD_DELAY_24H"}
#   Gate outcome: WOULD_DELAY_24H
```

Gate outcomes:
- `WOULD_DELAY_24H` — action is L0 with a 24-hour delay required.
- `WOULD_REQUIRE_TYPED_CONFIRM` — action requires the typed-CONFIRM modal.
- `WOULD_EXECUTE_L2_PLUS` — action would proceed with L2+ approval.

### 6.3 Abort Pending

```bash
homelab autofix abort-pending <action-id>
# Cancels a pending delayed action.
# Writes an action.cancelled audit event.

# Equivalent to:
homelab cancel-action <action-id>
```

---

## 7. Portal Verification

```bash
homelab portal
# Opens the homelab panel at http://localhost:3000 (default).
# Verify:
#   - No console errors in browser dev-tools.
#   - Inventory panel shows 3 hosts.
#   - Observations panel lists recent observations.
#   - SSE metrics update within 5 seconds.

homelab metrics show
# Print current safety + observability metrics to stdout.
```

---

## 8. Upgrade / Rollback

### Upgrade
```bash
# Build new version
npm version patch  # or minor/major
npm run build && npm run package

# Install alongside existing
bash scripts/deploy/upgrade.sh dist/autonomous-dev-homelab-<new-version>.tgz
# Symlink flips to new version; previous version retained for rollback.
```

### Rollback
```bash
bash scripts/deploy/rollback.sh [<previous-version>]
# Without an argument, rolls back to the previous version.
# Symlink flips back; log entry written to ~/.autonomous-dev-homelab/installs.log.
```

Install history:
```bash
cat ~/.autonomous-dev-homelab/installs.log
```

---

## 9. Troubleshooting

### Vault Errors

| Exit | Error Class | Cause | Fix |
|---|---|---|---|
| 20 | `VaultUnreachableError` | Vault at `address` is down or network unreachable | Check `curl https://vault.pwatson.space:8200/v1/sys/health` |
| 21 | `VaultAuthError` | `VAULT_ROLE_ID` or `VAULT_SECRET_ID` wrong/missing | Re-export the correct values; check AppRole permissions in Vault |
| 22 | `VaultPermissionError` | AppRole policy lacks read on `kv/data/homelab/ssh` | Update Vault policy for the AppRole |
| 23 | `SecretMissingError` | `vault_path` or `vault_field` not found in Vault | Check Vault KV path with `vault kv get kv/homelab/ssh` |

### MCP Unreachable
If MCP is not running on a host, the transport selector falls back to SSH automatically. The audit log records `transport_reason: "mcp-not-configured"` or `"mcp-unreachable"`. No action required unless MCP is expected.

### SSH Host Key Mismatch
If the plugin emits `SSH_HOST_KEY_UNPINNED` warnings, add `known_hosts_ref` to the host's `ssh_fallback` in the config, pointing to a Vault KV field containing the expected host fingerprint.

### Config Errors (exit 11/12)
```bash
homelab config validate --config ~/.autonomous-dev-homelab/homelab.config.yaml
```
Errors are printed with field paths: `config.hosts[0].ssh_fallback.key_ref.vault_path: ...`.

### Discovery Platform Mismatch (exit 30)
The observed platform fingerprint didn't match the declared `platform` in the config. Update the config `platform` field to match the actual fingerprint, or investigate why the host is presenting differently.

### Connect Failure (exit 31)
One or more hosts failed the connectivity test. Check:
1. SSH port is open: `nc -zv <host> 22`
2. Vault credential resolves correctly: `homelab vault ping`
3. SSH key in Vault is correct for the target host user
4. The `user` field in `ssh_fallback` matches the host's authorized keys

### Timer Leak Warning
If tests emit "worker process has failed to exit gracefully", this is a known timing issue with the fixture server. Tests still pass. Run with `--detectOpenHandles` to trace.

---

## Appendix: Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AUTONOMOUS_DEV_HOMELAB_CONFIG` | Override path to `homelab.config.yaml` | `~/.autonomous-dev-homelab/homelab.config.yaml` |
| `AUTONOMOUS_DEV_HOMELAB_DATA_DIR` | Data directory for audit log, inventory | `$CWD/.autonomous-dev-homelab` |
| `VAULT_ROLE_ID` | AppRole Role ID | (required for live ops) |
| `VAULT_SECRET_ID` | AppRole Secret ID | (required for live ops) |
| `VAULT_TOKEN` | Static token (development only) | (optional; overrides AppRole) |
| `LIVE` | Set to `1` to run live integration tests | (unset by default) |
| `INTEGRATION` | Set to `1` to run build pipeline integration tests | (unset by default) |
