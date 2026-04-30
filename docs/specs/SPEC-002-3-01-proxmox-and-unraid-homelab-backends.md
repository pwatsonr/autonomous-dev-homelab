# SPEC-002-3-01: ProxmoxHomelabBackend and UnraidHomelabBackend

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 1 (`ProxmoxHomelabBackend` implementation), Task 2 (`UnraidHomelabBackend` implementation)
- **Estimated effort**: 8 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-3-01-proxmox-and-unraid-homelab-backends.md`

## Description
Implement the first two homelab `DeploymentBackend` (autonomous-dev SPEC-023-1-01) implementations: `ProxmoxHomelabBackend` and `UnraidHomelabBackend`. Both build on the connection layer from PLAN-001-2 (SSH cert auth + connection pool) and the platform fingerprints from PLAN-001-1. Both pass autonomous-dev's bundled conformance suite (SPEC-023-1-04) without modification, sign their `DeploymentRecord`s via the SPEC-023-1-01 helpers, and validate their `DeployParameters` against a typed `PARAM_SCHEMA`.

`ProxmoxHomelabBackend` deploys via the Proxmox CLIs (`pct create` for LXC containers, `qm create` for VMs) executed over SSH against a Proxmox node; image pulls come from a configured registry whose URL is supplied per deploy. `UnraidHomelabBackend` deploys Docker containers via Unraid's `emhttp` HTTP API, with persistent storage backed by Unraid array shares whose paths are supplied per deploy. Conformance suite extension, registration with `BackendRegistry`, and the other two backends are delivered by SPEC-002-3-02. Unit tests are delivered by SPEC-002-3-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/deploy/backends/proxmox.ts` | Create | `ProxmoxHomelabBackend implements DeploymentBackend` + `PARAM_SCHEMA` |
| `plugins/autonomous-dev-homelab/src/deploy/backends/unraid.ts` | Create | `UnraidHomelabBackend implements DeploymentBackend` + `PARAM_SCHEMA` |
| `plugins/autonomous-dev-homelab/src/deploy/backends/proxmox-cli.ts` | Create | Helpers: `runPctCreate`, `runQmCreate`, `getContainerStatus`, `parseVmid` |
| `plugins/autonomous-dev-homelab/src/deploy/backends/unraid-emhttp-client.ts` | Create | HTTP client wrapping `emhttp` endpoints (`/Docker/AddContainer`, `/Docker/Update`, `/Docker/Remove`) |
| `plugins/autonomous-dev-homelab/src/deploy/backends/registry-pull.ts` | Create | Shared image-pull helper used by both backends (resolves digest, retries on transient pull failures) |

## Implementation Details

### `ProxmoxHomelabBackend` (`src/deploy/backends/proxmox.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  node_id: { type: 'string', required: true, format: 'identifier' },          // matches inventory entry id
  workload_kind: { type: 'string', required: true, enum: ['lxc', 'vm'] },
  vmid: { type: 'number', required: true, range: [100, 999999] },             // Proxmox VMID space
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },    // OCI image OR template tarball
  registry_url: { type: 'string', required: false, format: 'url' },
  storage_pool: { type: 'string', required: true, format: 'identifier' },     // e.g. 'local-lvm'
  hostname: { type: 'string', required: true, format: 'identifier' },
  ip_cidr: { type: 'string', required: false, regex: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/ },
  cores: { type: 'number', default: 1, range: [1, 64] },
  memory_mb: { type: 'number', default: 512, range: [128, 524288] },
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'proxmox',
  version: '0.1.0',
  supportedTargets: ['homelab-proxmox'],   // matches PLAN-001-1 inventory entry type
  capabilities: ['lxc-create', 'qm-create'],
  requiredTools: [],                       // pct/qm invoked over SSH; nothing on the daemon host
  minPlatformVersion: '7.0',               // Proxmox VE >= 7.0; recorded for connection-test surfacing
};
```

- **`build(ctx)`**:
  - For `workload_kind: 'lxc'`: shells `pct create <vmid> <image_uri> --storage <storage_pool> --hostname <hostname> --cores <cores> --memory <memory_mb> [--net0 name=eth0,ip=<ip_cidr>]` over the PLAN-001-2 `ProxmoxConnection` for `node_id`.
  - For `workload_kind: 'vm'`: shells `qm create <vmid> --name <hostname> --cores <cores> --memory <memory_mb> --net0 virtio,bridge=vmbr0 --ide2 <storage_pool>:cloudinit --boot order=scsi0` then `qm importdisk <vmid> <image_uri> <storage_pool>`.
  - Captures the previous container/VM record (if any) by reading `/var/lib/autonomous-dev-homelab/proxmox/<vmid>.json` on the daemon's data dir for use by `rollback`. If none, `previous_vmid` is null.
  - Returns `BuildArtifact { type: 'proxmox-instance', location: \`proxmox://${node_id}/${workload_kind}/${vmid}\`, checksum: <sha256 of pct/qm config dump>, sizeBytes: <reported by storage_pool>, metadata: { node_id, vmid, workload_kind, hostname, image_uri, registry_url, previous_vmid } }`.
  - On `pct create` exit-non-zero, throws `DeployError { code: 'BUILD_FAILED', message: <stderr first 500 chars> }`.

- **`deploy(artifact, env, params)`**:
  - Validates `params` against `PARAM_SCHEMA`. Rejects if `vmid` is in the reserved range (< 100).
  - Acquires a `ProxmoxConnection` for `params.node_id` from the connection pool.
  - For LXC: `pct start <vmid>`. Polls `pct status <vmid>` every 2s until `running` or 60s elapsed.
  - For VM: `qm start <vmid>`. Polls `qm status <vmid>` every 2s until `running` or 60s elapsed.
  - Resolves the assigned IP: for LXC, runs `pct exec <vmid> -- ip -j addr show eth0`; for VM, polls the cloud-init metadata endpoint or `qm guest cmd <vmid> network-get-interfaces`.
  - Persists the new record at `<homelab-data>/proxmox/<vmid>.json` (HMAC-signed) with `previous_vmid` from the build artifact metadata.
  - Returns signed `DeploymentRecord` with `details: { node_id, vmid, workload_kind, ip, hostname, image_uri, previous_vmid, started_at }`.

- **`healthCheck(record)`**:
  - When `params.health_url` is set, polls it via `fetch` at 5s intervals up to `params.health_timeout_seconds`. First 200..299 returns `healthy: true`.
  - When `params.health_url` is unset, runs `pct exec <vmid> -- /bin/true` (LXC) or `qm guest cmd <vmid> ping` (VM); success → `healthy: true`.
  - `checks[]` retains the last 5 probe entries with `timestamp`, `outcome`, `latencyMs`.
  - On timeout, `unhealthyReason` includes the last probe's HTTP status or stderr.

- **`rollback(record)`**:
  - Reads `record.details.previous_vmid`. If null, returns `{ success: false, errors: ['no previous record to roll back to'] }`.
  - Stops new: `pct stop <vmid>` (or `qm stop <vmid>`).
  - Starts previous: `pct start <previous_vmid>` (or `qm start <previous_vmid>`).
  - Polls until previous reaches `running` (60s timeout). Failure is surfaced in `errors[]`.
  - Returns `RollbackResult { success, restoredArtifactId: \`proxmox://${node_id}/${workload_kind}/${previous_vmid}\`, errors }`.

### `UnraidHomelabBackend` (`src/deploy/backends/unraid.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  host_id: { type: 'string', required: true, format: 'identifier' },          // matches inventory entry id
  container_name: { type: 'string', required: true, format: 'identifier' },
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },
  registry_url: { type: 'string', required: false, format: 'url' },
  network_mode: { type: 'string', default: 'bridge', enum: ['bridge', 'host', 'none'] },
  port_mappings: { type: 'array', default: [], items: { type: 'string', regex: /^\d{1,5}:\d{1,5}(\/(tcp|udp))?$/ } },
  storage_mounts: {
    type: 'array',
    default: [],
    items: {
      type: 'object',
      properties: {
        host_path: { type: 'string', required: true, format: 'absolute-path' },  // must reside under an Unraid array share
        container_path: { type: 'string', required: true, format: 'absolute-path' },
        readonly: { type: 'boolean', default: false },
      },
    },
  },
  env: { type: 'object', default: {}, additionalProperties: { type: 'string' } },
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 120, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'unraid',
  version: '0.1.0',
  supportedTargets: ['homelab-unraid'],
  capabilities: ['unraid-docker'],
  requiredTools: [],
};
```

- **`build(ctx)`**:
  - Acquires the `UnraidConnection` for `params.host_id` from the connection pool. The connection wraps the operator's `emhttp` session token (already established by PLAN-001-2).
  - Calls the shared `registry-pull.ts` helper which issues `POST /Docker/PullImage` with body `{ image: image_uri }` and polls `GET /Docker/PullStatus?image=<image>` every 2s up to 5 minutes. Returns the image digest from the final status payload.
  - Captures the existing container's full config (if any) by `GET /Docker/InspectContainer?name=<container_name>`; stores as `previous_container_config` in artifact metadata. If none, value is null.
  - Returns `BuildArtifact { type: 'docker-image', location: \`docker://${image_uri}@${digest}\`, checksum: <digest>, sizeBytes: <reported by emhttp>, metadata: { host_id, container_name, image_uri, digest, previous_container_config } }`.

- **`deploy(artifact, env, params)`**:
  - Validates `params`. Rejects any `storage_mounts[].host_path` whose prefix is NOT in the Unraid host's array-shares list (fetched once via `GET /Shares` and cached on the connection).
  - If a container with the same name exists, calls `POST /Docker/StopContainer?name=<container_name>` (waits up to 30s for graceful stop).
  - Calls `POST /Docker/AddContainer` with body:
    ```json
    {
      "name": "<container_name>",
      "image": "<image_uri>@<digest>",
      "network_mode": "<network_mode>",
      "ports": <port_mappings>,
      "volumes": <storage_mounts>,
      "env": <env>
    }
    ```
  - On success, calls `POST /Docker/StartContainer?name=<container_name>` and polls `GET /Docker/InspectContainer?name=<container_name>` until `state.running == true` or 60s elapses.
  - Persists `<homelab-data>/unraid/<container_name>.json` (HMAC-signed) with `previous_container_config`.
  - Returns signed `DeploymentRecord` with `details: { host_id, container_name, image_uri, digest, previous_container_config, started_at }`.

- **`healthCheck(record)`**:
  - When `params.health_url` is set, polls it via `fetch` at 5s intervals up to `params.health_timeout_seconds`.
  - Otherwise calls `GET /Docker/InspectContainer?name=<container_name>` and inspects `state.health.status` (`healthy` / `starting` / `unhealthy`); maps to `healthy: true` only when value is `healthy`.
  - `checks[]` retains the last 5 probe entries.

- **`rollback(record)`**:
  - Reads `record.details.previous_container_config`. If null, returns `{ success: false, errors: ['no previous container to roll back to'] }`.
  - `POST /Docker/StopContainer?name=<container_name>` then `POST /Docker/RemoveContainer?name=<container_name>`.
  - `POST /Docker/AddContainer` with the captured `previous_container_config` payload, then `POST /Docker/StartContainer`.
  - Polls until `state.running == true` (60s timeout). Failure surfaces in `errors[]`.
  - Returns `RollbackResult { success, restoredArtifactId: \`docker://${previous_container_config.image}\`, errors }`.

### Shared registry-pull helper (`src/deploy/backends/registry-pull.ts`)

```ts
export interface PullResult { digest: string; sizeBytes: number; pulledAt: string; }
export async function pullImage(conn: HomelabConnection, opts: { image: string; registry?: string }): Promise<PullResult>;
```

- Backs both `UnraidHomelabBackend.build` (via `emhttp`) and `ProxmoxHomelabBackend.build` (via `pct pull --image` shell over SSH).
- Retries on transient errors (network, registry 5xx) with 2s/4s/8s backoff, max 3 attempts.
- Surfaces `DeployError { code: 'IMAGE_PULL_FAILED', retriable: true }` when all retries exhausted.

## Acceptance Criteria

- [ ] `ProxmoxHomelabBackend implements DeploymentBackend` — TypeScript compiles under `strict: true` with no `any`.
- [ ] `UnraidHomelabBackend implements DeploymentBackend` — TypeScript compiles under `strict: true` with no `any`.
- [ ] Both classes export `PARAM_SCHEMA` matching the schema passed to `validateParameters` from autonomous-dev SPEC-023-1-01.
- [ ] `ProxmoxHomelabBackend.metadata.name === 'proxmox'` and `metadata.supportedTargets === ['homelab-proxmox']`.
- [ ] `UnraidHomelabBackend.metadata.name === 'unraid'` and `metadata.supportedTargets === ['homelab-unraid']`.
- [ ] `ProxmoxHomelabBackend.build` rejects `vmid < 100` with `DeployError { code: 'INVALID_PARAMS' }`.
- [ ] `ProxmoxHomelabBackend.build` invokes `pct create` when `workload_kind == 'lxc'` and `qm create` when `workload_kind == 'vm'` (verified by spying on the `ProxmoxConnection.exec` mock).
- [ ] `ProxmoxHomelabBackend.deploy` resolves the assigned IP into `record.details.ip` for both LXC (`pct exec ... ip -j addr`) and VM (`qm guest cmd ... network-get-interfaces`) paths.
- [ ] `ProxmoxHomelabBackend.deploy` returns a signed `DeploymentRecord` whose `hmac` field is non-empty AND passes `verifyDeploymentRecord` from autonomous-dev SPEC-023-1-01.
- [ ] `ProxmoxHomelabBackend.rollback` returns `{ success: false, errors: ['no previous record to roll back to'] }` when `previous_vmid` is null (no shell calls executed; verified by mock-call count == 0).
- [ ] `UnraidHomelabBackend.deploy` REJECTS any `storage_mounts[].host_path` whose prefix is not in the cached Unraid shares list, with `DeployError { code: 'INVALID_PARAMS' }`.
- [ ] `UnraidHomelabBackend.deploy` calls `POST /Docker/StopContainer` BEFORE `POST /Docker/AddContainer` when a container with the same name already exists (verified by mock call order).
- [ ] `UnraidHomelabBackend.healthCheck` returns `healthy: true` only when Unraid `state.health.status == 'healthy'` (the `starting` and `unhealthy` states map to `healthy: false`).
- [ ] `UnraidHomelabBackend.rollback` recreates the previous container with the EXACT captured `previous_container_config` payload (verified by mock-call deep-equal assertion).
- [ ] Shared `registry-pull.ts` retries up to 3 times on registry 5xx; final failure throws `DeployError { code: 'IMAGE_PULL_FAILED', retriable: true }`.
- [ ] Both backends do NOT shell out via `child_process` directly — all command execution flows through the `HomelabConnection.exec` interface from PLAN-001-2.
- [ ] Persisted records at `<homelab-data>/proxmox/<vmid>.json` and `<homelab-data>/unraid/<container_name>.json` are HMAC-signed using the same helper as `signDeploymentRecord` (no plaintext-only persistence).

## Dependencies

- **autonomous-dev SPEC-023-1-01**: `DeploymentBackend`, `BuildContext`, `DeployParameters`, `BuildArtifact`, `DeploymentRecord`, `HealthStatus`, `RollbackResult`, `validateParameters`, `signDeploymentRecord`, `verifyDeploymentRecord`, `DeployError`, `BackendMetadata`, `ParamSchema`.
- **autonomous-dev SPEC-023-1-04**: conformance suite (consumed in SPEC-002-3-02 + SPEC-002-3-04 tests).
- **PLAN-001-1** (existing): inventory schema and platform-fingerprint entry types `homelab-proxmox`, `homelab-unraid`.
- **PLAN-001-2** (existing): `ProxmoxConnection`, `UnraidConnection`, connection pool, SSH cert auth.
- **No new npm packages** introduced by this spec; HTTP client uses the existing `fetch` available in the runtime.

## Notes

- Both backends defer image building to the platform itself (Proxmox: `pct create` consumes a template URL; Unraid: `emhttp` pulls via Docker daemon). Neither backend builds Docker images locally — operators wanting custom images must publish to a registry first.
- `previous_vmid` (Proxmox) and `previous_container_config` (Unraid) are persisted at deploy time so rollback can target the exact prior state. If the daemon's data directory is cleared between deploy and rollback, rollback returns `success: false` with a clear error rather than silently re-deploying the new artifact.
- Conformance suite extension (registering homelab-specific test cases) and the BackendRegistry registration are deliberately deferred to SPEC-002-3-02 so this spec can be reviewed and tested in isolation against a fixture connection.
- Health probe modes are per-backend defaults: Proxmox falls back to `pct exec /bin/true` because Proxmox containers may not expose HTTP. Unraid falls back to Docker's native health-check status because Unraid Docker containers commonly declare `HEALTHCHECK` in their Dockerfile.
- `port_mappings` and `storage_mounts` formats mirror the Unraid `emhttp` payload exactly to avoid a translation layer; future backends with different schemas will need their own adapters.
