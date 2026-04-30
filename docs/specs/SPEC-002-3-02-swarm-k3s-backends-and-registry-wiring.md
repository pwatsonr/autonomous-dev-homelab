# SPEC-002-3-02: DockerSwarm + K3s Backends and BackendRegistry Wiring

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 3 (`DockerSwarmHomelabBackend`), Task 4 (`K3sHomelabBackend`), Task 5 (register all four homelab backends with autonomous-dev's `BackendRegistry`)
- **Estimated effort**: 8.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-3-02-swarm-k3s-backends-and-registry-wiring.md`

## Description
Implement the remaining two homelab `DeploymentBackend` implementations and register all four homelab backends with autonomous-dev's `BackendRegistry` (autonomous-dev SPEC-023-1-04). `DockerSwarmHomelabBackend` deploys via `docker stack deploy` against a Swarm manager reachable through the PLAN-001-2 connection layer; build is a deliberate no-op because Swarm assumes the image already exists in a registry. `K3sHomelabBackend` is a thin wrapper around autonomous-dev's `K8sBackend` (autonomous-dev SPEC-024-1-03) configured with homelab-specific defaults (default namespace, scoped kubeconfig sourced from autonomous-dev SPEC-024-2-01's `CredentialProxy` issuing 15-minute tokens).

The plugin entrypoint registers `proxmox`, `unraid`, `docker-swarm`, and `k3s` with `BackendRegistry` at session start. Registration is gated by autonomous-dev SPEC-019-3's trust validation (each backend must be allowlisted in `extensions.privileged_backends`); the entrypoint surfaces a clear error if any backend fails the allowlist check. After successful registration, all four backends appear in `deploy backends list` from the autonomous-dev CLI. Per-backend unit tests are delivered in SPEC-002-3-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/deploy/backends/docker-swarm.ts` | Create | `DockerSwarmHomelabBackend implements DeploymentBackend` + `PARAM_SCHEMA` |
| `plugins/autonomous-dev-homelab/src/deploy/backends/k3s.ts` | Create | `K3sHomelabBackend extends K8sBackend` (autonomous-dev SPEC-024-1-03) with homelab defaults |
| `plugins/autonomous-dev-homelab/src/deploy/backends/k3s-credential-client.ts` | Create | Wraps `CredentialProxy.acquire('k8s', op, scope)` to return a `KubeConfig` with 15-min token |
| `plugins/autonomous-dev-homelab/src/deploy/registry-wiring.ts` | Create | `registerHomelabBackends(registry, allowlist)` — single entrypoint that registers all four backends |
| `plugins/autonomous-dev-homelab/src/index.ts` | Create | Plugin entry point: imports `registry-wiring.ts` and runs registration on session start |
| `plugins/autonomous-dev-homelab/.claude-plugin/plugin.json` | Modify | Add `depends_on: ['autonomous-dev', 'autonomous-dev-deploy-k8s']` |

## Implementation Details

### `DockerSwarmHomelabBackend` (`src/deploy/backends/docker-swarm.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  manager_id: { type: 'string', required: true, format: 'identifier' },          // matches inventory entry id
  stack_name: { type: 'string', required: true, regex: /^[a-z0-9][a-z0-9_-]{0,62}$/ },
  compose_file_path: { type: 'string', required: true, format: 'path' },          // resolved relative to ctx.repoPath
  image_uri: { type: 'string', required: true, format: 'shell-safe-arg' },       // already pushed to registry
  service_name: { type: 'string', required: true, format: 'identifier' },         // service inside the stack to track
  health_url: { type: 'string', required: false, format: 'url' },
  health_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'docker-swarm',
  version: '0.1.0',
  supportedTargets: ['homelab-docker-swarm'],
  capabilities: ['docker-stack-deploy'],
  requiredTools: [],
};
```

- **`build(ctx)`**: NO-OP by design. Returns `BuildArtifact { type: 'commit', location: ctx.commitSha, checksum: sha256(ctx.commitSha + ctx.requestId), sizeBytes: 0, metadata: { kind: 'docker-stack-ref', stack_name: params.stack_name } }`. The Swarm cluster pulls the image at deploy time; this backend does not push images. Operators run their own image pipeline (CI, registry).
- **`deploy(artifact, env, params)`**:
  - Validates `params`. Reads `compose_file_path` from disk; rejects if path resolves outside `ctx.repoPath`.
  - Acquires the `DockerSwarmConnection` for `params.manager_id` via the PLAN-001-2 connection pool.
  - Captures the existing service spec (if any): `docker service inspect <stack_name>_<service_name>` over SSH; stores as `previous_service_spec` in record details. If service does not yet exist, value is null.
  - Runs `docker stack deploy --compose-file <compose_file_path> --with-registry-auth <stack_name>` over SSH.
  - On non-zero exit, throws `DeployError { code: 'DEPLOY_FAILED', message: <stderr first 500 chars> }`.
  - Returns signed `DeploymentRecord` with `details: { manager_id, stack_name, service_name, image_uri, previous_service_spec, deployed_at }`.
- **`healthCheck(record)`**:
  - When `params.health_url` is set, polls it at 5s intervals up to `params.health_timeout_seconds`.
  - Otherwise polls `docker service ps <stack_name>_<service_name> --format json --no-trunc` every 5s; `healthy: true` once the count of `Running` tasks equals `Replicas` AND no task is in `Failed` state.
  - `checks[]` retains the last 5 probe entries; `unhealthyReason` includes the last task's `Error` field when timeout hit.
- **`rollback(record)`**:
  - When `previous_service_spec` is null: returns `{ success: false, errors: ['no previous service spec to roll back to'] }`.
  - Otherwise runs `docker service rollback <stack_name>_<service_name>` over SSH (Swarm tracks the previous spec automatically; this command swaps to it).
  - Polls `docker service inspect ... --format '{{.UpdateStatus.State}}'` until `completed` (90s timeout). Failure surfaces in `errors[]`.
  - Returns `RollbackResult { success, restoredArtifactId: \`docker-swarm://${manager_id}/${stack_name}/${service_name}@previous\`, errors }`.

### `K3sHomelabBackend` (`src/deploy/backends/k3s.ts`)

```ts
export const PARAM_SCHEMA: Record<string, ParamSchema> = {
  cluster_id: { type: 'string', required: true, format: 'identifier' },          // matches inventory entry id
  namespace: { type: 'string', default: 'default', format: 'identifier' },        // homelab default differs from autonomous-dev's required field
  manifest_path: { type: 'string', required: true, format: 'path' },
  deployment_name: { type: 'string', required: true, format: 'identifier' },
  ready_timeout_seconds: { type: 'number', default: 180, range: [10, 600] },
};

readonly metadata: BackendMetadata = {
  name: 'k3s',
  version: '0.1.0',
  supportedTargets: ['homelab-k3s'],
  capabilities: ['k3s-kubectl-apply'],
  requiredTools: [],
  minPlatformVersion: '1.24',                  // K3s/K8s API >= 1.24
};
```

- **Composition over inheritance**: `K3sHomelabBackend` holds a private `K8sBackend` instance (autonomous-dev SPEC-024-1-03). All four interface methods delegate to the wrapped instance after applying homelab defaults and rewriting `params` to match the `K8sBackend` `PARAM_SCHEMA`.
- **`build(ctx)`**: Delegates to `K8sBackend.build(ctx)` (also a no-op; returns the commit-ref artifact).
- **`deploy(artifact, env, params)`**:
  - Translates `params.cluster_id` into a `context_name` (the `K8sBackend` parameter) by reading the inventory entry's `kubeconfig_context` field.
  - Calls `k3s-credential-client.acquire(cluster_id, op: 'K8s:Apply', scope: \`cluster:${context_name}/namespace:${params.namespace}\`)` to obtain a 15-min scoped kubeconfig YAML. Per autonomous-dev SPEC-024-2-01's contract, the kubeconfig grants only the requested namespace.
  - Calls `K8sBackend.deploy(artifact, env, { ...translatedParams, context_name, scopedKubeconfig: cred.kubeconfig })`.
  - Returns the underlying record with `metadata.backendName: 'k3s'` (override) and adds `details.cluster_id`.
- **`healthCheck(record)`**: Acquires a fresh 15-min credential, then delegates to `K8sBackend.healthCheck(record)`.
- **`rollback(record)`**: Acquires `K8s:Patch`-scoped credential, then delegates to `K8sBackend.rollback(record)`.

### `k3s-credential-client.ts`

```ts
export interface ScopedKubeconfigRequest { clusterId: string; op: 'K8s:Apply' | 'K8s:Patch' | 'K8s:Read'; scope: string; }
export async function acquire(req: ScopedKubeconfigRequest): Promise<{ kubeconfig: string; expiresAt: string; tokenLifetimeSeconds: 900 }>;
```

- Wraps `CredentialProxy.acquire('k8s', req.op, { resource: req.scope })` from autonomous-dev SPEC-024-2-01.
- Asserts `tokenLifetimeSeconds === 900` (15 min); throws if proxy returns a longer-lived credential. This is defense-in-depth against proxy misconfiguration.
- Caches NOTHING — every backend call acquires a fresh credential. (Justification: 15-min tokens with high call rate would still need refresh; caching adds invalidation complexity for marginal gain.)

### Registry wiring (`src/deploy/registry-wiring.ts`)

```ts
export interface RegisterOptions {
  registry: BackendRegistry;       // from autonomous-dev SPEC-023-1-04
  allowlist: ReadonlyArray<string>; // value of extensions.privileged_backends
}

export function registerHomelabBackends(opts: RegisterOptions): { registered: string[]; rejected: { name: string; reason: string }[] };
```

- Iterates over the four backends in this order: `proxmox`, `unraid`, `docker-swarm`, `k3s`.
- For each backend:
  - Instantiates the class.
  - Checks `opts.allowlist.includes(backend.metadata.name)`. If not, pushes `{ name, reason: 'not in extensions.privileged_backends allowlist' }` into `rejected[]` and skips.
  - Otherwise calls `opts.registry.register(backend)`. If `register` throws (autonomous-dev SPEC-019-3 trust check failed), pushes `{ name, reason: <err.message> }` into `rejected[]`.
  - On success, pushes `name` into `registered[]`.
- Returns the summary; never throws on registration failure (caller logs the rejected list; this lets the plugin still load even if one backend's allowlist is missing).

### Plugin entry point (`src/index.ts`)

```ts
export async function activate(ctx: PluginActivateContext): Promise<void> {
  const { registry, config, logger } = ctx;
  const allowlist = config.get('extensions.privileged_backends', []) as string[];
  const result = registerHomelabBackends({ registry, allowlist });
  for (const name of result.registered) logger.info(`registered backend: ${name}`);
  for (const r of result.rejected) logger.warn(`backend ${r.name} not registered: ${r.reason}`);
}
```

- The `activate(ctx)` shape conforms to autonomous-dev's plugin lifecycle (PLAN-019-1). `ctx.registry` is the live `BackendRegistry`; `ctx.config` exposes the resolved operator config; `ctx.logger` is structured.
- Activation is idempotent — re-running `activate` against an already-populated registry is a no-op (registry's `register` rejects duplicates with a clear error caught and logged).

### `plugin.json` modification

Add to the existing manifest:
```json
{
  "depends_on": ["autonomous-dev", "autonomous-dev-deploy-k8s"]
}
```

This declares an install-order dependency so PLAN-019-1's plugin loader installs `autonomous-dev-deploy-k8s` (which provides `K8sBackend` + `CredentialProxy`) before `autonomous-dev-homelab`. Without this, `K3sHomelabBackend`'s import of `K8sBackend` would fail at activation.

## Acceptance Criteria

- [ ] `DockerSwarmHomelabBackend implements DeploymentBackend` — TypeScript compiles under `strict: true` with no `any`.
- [ ] `K3sHomelabBackend implements DeploymentBackend` — TypeScript compiles under `strict: true` with no `any`.
- [ ] `DockerSwarmHomelabBackend.metadata.name === 'docker-swarm'` and `metadata.supportedTargets === ['homelab-docker-swarm']`.
- [ ] `DockerSwarmHomelabBackend.build` returns a `BuildArtifact { type: 'commit', sizeBytes: 0 }` whose `checksum` is reproducible across two calls with identical context (verified by direct equality of two outputs).
- [ ] `DockerSwarmHomelabBackend.deploy` runs `docker stack deploy --compose-file <path> --with-registry-auth <stack_name>` (verified by mock-call argument-deep-equal).
- [ ] `DockerSwarmHomelabBackend.deploy` rejects a `compose_file_path` that resolves outside `ctx.repoPath` with `DeployError { code: 'INVALID_PARAMS' }`.
- [ ] `DockerSwarmHomelabBackend.healthCheck` returns `healthy: true` when `Running` task count equals `Replicas` AND no `Failed` task; otherwise `healthy: false` with `unhealthyReason` derived from the failed task's `Error` field.
- [ ] `DockerSwarmHomelabBackend.rollback` runs `docker service rollback <stack_name>_<service_name>` and waits for `UpdateStatus.State == 'completed'`; `previous_service_spec == null` returns `{ success: false }` without invoking rollback.
- [ ] `K3sHomelabBackend.metadata.name === 'k3s'` and `metadata.supportedTargets === ['homelab-k3s']`.
- [ ] `K3sHomelabBackend.deploy` calls `k3s-credential-client.acquire` exactly once with `scope: \`cluster:<ctx>/namespace:<ns>\`` (verified by mock-call assertion).
- [ ] `K3sHomelabBackend` does NOT shell out — all K8s operations flow through the wrapped `K8sBackend` typed client (verified by spying on `child_process` showing zero calls).
- [ ] `k3s-credential-client.acquire` THROWS when the proxy returns `tokenLifetimeSeconds > 900`.
- [ ] `K3sHomelabBackend.deploy` honors the homelab default `namespace: 'default'` when the operator's `params.namespace` is unset.
- [ ] `registerHomelabBackends` registers all four backends in order `[proxmox, unraid, docker-swarm, k3s]` when all are allowlisted.
- [ ] `registerHomelabBackends` SKIPS (and reports in `rejected[]`) any backend whose name is NOT in `extensions.privileged_backends`; subsequent backends still register.
- [ ] `registerHomelabBackends` returns `{ registered, rejected }` and NEVER throws on per-backend failure (verified by mocking `registry.register` to throw for one backend; remaining three still register).
- [ ] `activate(ctx)` is idempotent — calling twice with the same already-populated registry produces zero new registrations and does not throw (errors logged at WARN).
- [ ] After `activate`, `registry.list().map(b => b.metadata.name).sort()` returns `['docker-swarm', 'k3s', 'proxmox', 'unraid']` plus any pre-existing autonomous-dev bundled backends.
- [ ] `plugin.json` `depends_on` includes both `autonomous-dev` and `autonomous-dev-deploy-k8s`; missing either causes the plugin loader to refuse activation (verified by test fixture removing the dependency).
- [ ] Each of the four homelab backends passes the autonomous-dev SPEC-023-1-04 conformance suite when run with mocked connections (test stub provided in this spec; full conformance run lives in SPEC-002-3-04).

## Dependencies

- **autonomous-dev SPEC-023-1-01**: `DeploymentBackend`, `BuildContext`, `DeployParameters`, `BuildArtifact`, `DeploymentRecord`, `HealthStatus`, `RollbackResult`, `validateParameters`, `signDeploymentRecord`, `DeployError`, `BackendMetadata`, `ParamSchema`.
- **autonomous-dev SPEC-023-1-04**: `BackendRegistry`, conformance suite.
- **autonomous-dev SPEC-024-1-03**: `K8sBackend` (composed by `K3sHomelabBackend`).
- **autonomous-dev SPEC-024-2-01**: `CredentialProxy`, `ScopedCredential`, allowlist semantics.
- **autonomous-dev PLAN-019-1**: plugin loader, `activate(ctx)` contract, `depends_on` enforcement.
- **autonomous-dev SPEC-019-3**: trust validation invoked during `registry.register`.
- **PLAN-001-2** (existing in homelab repo): `DockerSwarmConnection`, `K8sConnection` (for the credential-proxy bridge), connection pool.
- **SPEC-002-3-01** (companion): `ProxmoxHomelabBackend`, `UnraidHomelabBackend` (instantiated by `registry-wiring.ts`).
- **No new npm packages** introduced by this spec.

## Notes

- `DockerSwarmHomelabBackend.build` is a no-op for the same reason as autonomous-dev's `K8sBackend`: bringing a Docker daemon and image push into the backend would couple it to a registry choice. Operators run their own image pipeline.
- `K3sHomelabBackend` uses composition (not inheritance) over `K8sBackend` because the `metadata.name` and `supportedTargets` differ; subclassing would force a single `metadata` value across both. The wrapped instance is private; nothing outside `K3sHomelabBackend` should reach into it.
- The `cluster_id` → `kubeconfig_context` indirection is necessary because PLAN-001-1's inventory uses platform-friendly identifiers (`prod-k3s`), while `K8sBackend` uses kubeconfig-native context names (`prod-k3s.local-context`). The translation layer lives in `K3sHomelabBackend.deploy`.
- The 15-min credential lifetime is asserted (not just trusted from the proxy) because a misconfigured proxy that issues long-lived tokens would silently expand the blast radius of a compromised daemon. Failing fast at acquisition surfaces the misconfiguration immediately.
- `registerHomelabBackends` does not throw on per-backend failure because the homelab plugin should still load (and surface the missing-allowlist warning to the operator) even when only some backends are usable. This matches the "fail open with clear errors" pattern used elsewhere in autonomous-dev (SPEC-019-3).
- `depends_on: ['autonomous-dev-deploy-k8s']` creates a soft circular concern: operators who want only Proxmox/Unraid/Swarm and not K3s still must install the K8s plugin. Documented in the README; future enhancement is to make `K3sHomelabBackend` an optional sub-package.
- The `activate(ctx)` entry point is the ONLY runtime code in the plugin's index module. All other plugin behavior is loaded lazily on demand (CLI subcommands, portal panel) by autonomous-dev's lifecycle.
