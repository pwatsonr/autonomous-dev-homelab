# SPEC-002-3-03: Homelab Portal Panel, Safety Metrics, Grafana Dashboard, and CLI Surface

## Metadata
- **Parent Plan**: PLAN-002-3
- **Tasks Covered**: Task 6 (Homelab portal panel), Task 7 (metrics emitters), Task 8 (wire metrics into observation/action flow), Task 9 (`homelab metrics show` CLI), Task 10 (Grafana dashboard JSON), Task 11 (`homelab portal` CLI)
- **Estimated effort**: 15 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-3-03-portal-panel-metrics-and-cli-surface.md`

## Description
Stitch the homelab plugin into the operator's day-to-day surface. This spec adds the operator-facing observability layer per TDD-002 §13 + §14: a "Homelab" panel in autonomous-dev's portal (PLAN-013/014/015), four safety-metric emitters tied into the observation and action flows from PLAN-002-1 + PLAN-002-2, two CLI subcommands (`homelab metrics show`, `homelab portal`), and a Grafana dashboard JSON template that operators import into their own Grafana.

Metrics are emitted to autonomous-dev's TDD-007 metrics pipeline using stable names that match the dashboard's queries. The portal panel is read-only (consistent with TDD-002 §8 — destructive actions live behind typed-CONFIRM at the CLI). Real-time updates use the existing portal SSE channel; the homelab plugin emits events into that channel without owning any portal infrastructure of its own.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/portal/homelab-panel.ts` | Create | Route handlers + SSE event mapper |
| `plugins/autonomous-dev-homelab/src/portal/data-loader.ts` | Create | Reads inventory, observations, pending actions, migrations, audit from state files |
| `plugins/autonomous-dev-homelab/templates/homelab.html` | Create | Server-rendered shell with five sections; client JS subscribes to SSE for live updates |
| `plugins/autonomous-dev-homelab/src/metrics/emitters.ts` | Create | `emitMTTR`, `emitFPRate`, `emitGateLatency`, `emitBypassAttempt` |
| `plugins/autonomous-dev-homelab/src/metrics/clock-store.ts` | Create | Persists in-flight MTTR + gate-latency clocks (start times) at `<homelab-data>/metrics-clocks/<id>.json` |
| `plugins/autonomous-dev-homelab/src/observation/promoter.ts` | Modify | Start MTTR clock on observation; emit FP-rate on cancel |
| `plugins/autonomous-dev-homelab/src/safety/gate.ts` | Modify | Start gate-latency clock on gate fire; emit on completion |
| `plugins/autonomous-dev-homelab/src/safety/typed-confirm.ts` | Modify | Emit `bypass-attempt` on wrong-CONFIRM input |
| `plugins/autonomous-dev-homelab/src/safety/validator.ts` | Modify | Emit `bypass-attempt` on `config-below-floor` rejection |
| `plugins/autonomous-dev-homelab/src/cli/commands/metrics.ts` | Create | `homelab metrics show [--metric ...] [--json]` |
| `plugins/autonomous-dev-homelab/src/cli/commands/portal.ts` | Create | `homelab portal` opens browser to `/portal/homelab` |
| `plugins/autonomous-dev-homelab/dashboards/homelab.json` | Create | Grafana dashboard JSON, 5 panels, importable via Grafana UI |

## Implementation Details

### Metric names (canonical; used by dashboard + emitters + CLI)

```
homelab_mttr_seconds{platform=<id>, pattern=<name>}                  # histogram
homelab_fp_rate{probe=<name>}                                        # gauge (rolling 7d ratio)
homelab_gate_latency_seconds{action_type=<bug|infra|hotfix>, destructiveness=<level>}  # histogram
homelab_bypass_attempts_total{operator=<id>, reason=<config-below-floor|wrong-confirm|missing-admin>}  # counter
```

These names are STABLE — changing them requires a major plugin version bump and a dashboard republish (documented in operator README).

### Metric emitters (`src/metrics/emitters.ts`)

```ts
import { metrics } from '@autonomous-dev/metrics';     // TDD-007 pipeline client

export function emitMTTR(platform: string, pattern: string, durationMs: number): void;
export function emitFPRate(probe: string, isFalsePositive: boolean): void;       // emitter aggregates per probe
export function emitGateLatency(actionType: 'bug' | 'infra' | 'hotfix', destructiveness: Destructiveness, durationMs: number): void;
export function emitBypassAttempt(operatorId: string, reason: 'config-below-floor' | 'wrong-confirm' | 'missing-admin'): void;
```

- `emitMTTR` writes to the `homelab_mttr_seconds` histogram with labels `platform` + `pattern`.
- `emitFPRate` increments two internal counters (`fp_total`, `obs_total`) per probe and emits the rolling 7d ratio as `homelab_fp_rate` on each call. Counters live in `<homelab-data>/metrics-fp-counters.json` (HMAC-signed).
- `emitGateLatency` writes to `homelab_gate_latency_seconds` with labels `action_type` + `destructiveness`.
- `emitBypassAttempt` increments `homelab_bypass_attempts_total` with labels `operator` + `reason`.
- All emitters are synchronous-fire-and-forget; failures inside the metrics client are logged at WARN and never propagate (autonomous-dev TDD-007 contract).

### Clock store (`src/metrics/clock-store.ts`)

```ts
export interface Clock { id: string; kind: 'mttr' | 'gate-latency'; key: string; startedAt: number; metadata: Record<string, string>; }
export function start(kind: 'mttr' | 'gate-latency', key: string, metadata: Record<string, string>): string;  // returns clock id
export function stop(id: string): { startedAt: number; durationMs: number; metadata: Record<string, string> } | null;  // null on miss
export function purgeStale(olderThanMs: number): number;  // removes orphaned clocks; called from a daily timer
```

- Persists at `<homelab-data>/metrics-clocks/<id>.json` (HMAC-signed) so daemon restart preserves in-flight clocks.
- `key` for MTTR is the observation id; `key` for gate-latency is the action id. Same key + same kind raises `ClockAlreadyRunning` to surface programming errors.
- Stale clocks (no matching `stop` after 7 days) are reported in `homelab metrics show` as `orphaned_clocks` so operators can investigate stuck observations.

### Wiring into existing flows

**`src/observation/promoter.ts` (modify)**: After successful submission to autonomous-dev's intake queue, call `clockStore.start('mttr', observation.id, { platform, pattern })`. On observation cancel (PLAN-002-1's cancel path), call `emitFPRate(observation.probe, true)` and `clockStore.stop(\`mttr:${observation.id}\`)` without emitting MTTR (the observation never resolved). On a successful auto-rollback (PLAN-002-2's rollback path), also emit `emitFPRate(observation.probe, true)`.

**`src/safety/gate.ts` (modify)**: At the top of `gateApproval(action)`, call `clockStore.start('gate-latency', action.id, { actionType, destructiveness })`. After approval/rejection completes, call `clockStore.stop(\`gate-latency:${action.id}\`)` and `emitGateLatency(actionType, destructiveness, durationMs)`. On the action's downstream resolution (success or rollback), call `clockStore.stop(\`mttr:${action.observationId}\`)` and `emitMTTR(action.platform, action.pattern, durationMs)`.

**`src/safety/typed-confirm.ts` (modify)**: In the wrong-input branch (any input other than the literal `CONFIRM`), call `emitBypassAttempt(operatorId, 'wrong-confirm')` BEFORE returning `false`.

**`src/safety/validator.ts` (modify)**: In the `ConfigurationError` throw path (operator config below floor), call `emitBypassAttempt(operatorId, 'config-below-floor')` immediately before the throw. Also emit `emitBypassAttempt(operatorId, 'missing-admin')` when typed-CONFIRM bypass is attempted by a non-admin (the bypass-admin check inside `gate.ts` calls into `validator.ts` for the role check; this is where the emit fires).

### Portal panel (`src/portal/homelab-panel.ts` + `templates/homelab.html`)

Routes registered with autonomous-dev's portal router (PLAN-013-3):

```
GET /portal/homelab                  → renders templates/homelab.html with initial data snapshot
GET /portal/homelab/api/inventory    → JSON: list of platforms with status
GET /portal/homelab/api/observations?since=<ts>&platform=<id>&severity=<level>  → JSON
GET /portal/homelab/api/pending-actions  → JSON: actions in 24h delay or awaiting CONFIRM
GET /portal/homelab/api/migrations   → JSON: in-flight + recent (last 30d)
GET /portal/homelab/api/audit?since=<ts>  → JSON: recent safety events (ladder violations, bypass attempts)
GET /portal/homelab/sse              → SSE stream; emits events: observation.new, observation.resolved, action.status-changed, migration.phase-changed
```

`data-loader.ts` reads from the canonical state files written by PLAN-002-1/2:
- Inventory: `<homelab-data>/inventory.json` (PLAN-001-1)
- Observations: `<homelab-data>/observations/*.json` (PLAN-002-1)
- Pending actions: `<homelab-data>/pending-actions/*.json` (PLAN-002-2)
- Migrations: `<homelab-data>/migrations/*.json` (PLAN-002-2)
- Audit: `<homelab-data>/audit/*.json` (PLAN-002-2 + this spec's bypass-attempt emit also writes here)

`templates/homelab.html` is a server-rendered HTML shell with five `<section>` blocks (Inventory, Observations, Pending Actions, Migrations, Audit). A small client-side JS module (≤ 200 lines, vanilla, no framework) subscribes to `/portal/homelab/sse` and patches each section's DOM in place on each event. Last-update timestamp is shown in the panel header; SSE auto-reconnect retries every 5s on disconnect.

The panel is READ-ONLY: no buttons that mutate state. Every action link routes to the CLI command the operator must run (e.g., "Approve action ABC" links to `homelab approve ABC` documentation in the CLI section).

### `homelab metrics show` CLI (`src/cli/commands/metrics.ts`)

```
homelab metrics show [--metric mttr|fp_rate|gate_latency|bypass_attempts] [--json] [--since <duration>]
```

- Without `--metric`: prints summary table of all four metrics with current value + 30-day trend (sparkline).
- With `--metric mttr`: prints MTTR breakdown by platform × pattern (median, p95, count).
- With `--metric fp_rate`: prints FP-rate per probe with last-30-day trend.
- With `--metric gate_latency`: prints gate latency by action_type × destructiveness (p50, p95).
- With `--metric bypass_attempts`: prints count by operator × reason.
- `--json`: emits the same data as a structured JSON object suitable for piping to `jq` or external tooling.
- `--since <duration>`: accepts `1h`, `24h`, `7d`, `30d` (default `30d`).
- Reads from autonomous-dev's TDD-007 metrics pipeline via the same client used by emitters; falls back to local `<homelab-data>/metrics-fp-counters.json` for FP rate when the pipeline is unreachable (read-only mode banner shown).
- Includes `orphaned_clocks` count from `clockStore.purgeStale(0)` (dry-run mode that only reports without removing) at the bottom of the summary view.

### `homelab portal` CLI (`src/cli/commands/portal.ts`)

```
homelab portal [--no-open]
```

- Resolves the portal base URL from autonomous-dev's portal config (`portal.base_url`, default `http://127.0.0.1:19280`).
- Opens `<base_url>/portal/homelab` via `open` (macOS), `xdg-open` (Linux). Windows is out of scope (autonomous-dev portal is not Windows-supported).
- `--no-open` prints the URL instead of opening (useful for headless / SSH sessions). Default behavior also prints the URL after opening so operators can copy it.
- Returns exit code 0 on success, 1 if the portal server is unreachable (verified by a 1s `fetch` health probe to `<base_url>/portal/health` before opening).

### Grafana dashboard JSON (`dashboards/homelab.json`)

A valid Grafana dashboard JSON (schema version >= 38) with five panels:

| Panel | Type | Query (PromQL) |
|------|------|----------------|
| Per-platform observation count (24h) | Stat | `sum by (platform) (increase(homelab_mttr_seconds_count[24h]))` |
| MTTR by pattern (median p50) | Time series | `histogram_quantile(0.5, sum by (le, pattern) (rate(homelab_mttr_seconds_bucket[5m])))` |
| FP-rate trend (per probe) | Time series | `homelab_fp_rate` |
| Gate-latency p95 (by action_type) | Time series | `histogram_quantile(0.95, sum by (le, action_type) (rate(homelab_gate_latency_seconds_bucket[5m])))` |
| Bypass-attempt timeline | Bar chart | `sum by (reason) (increase(homelab_bypass_attempts_total[1h]))` |

JSON includes:
- `title: "Homelab — Observation, Safety, Audit"`
- `tags: ["autonomous-dev", "homelab"]`
- `version: 1` (incremented when panels change)
- `templating.list`: `platform` (multi-select, sourced from `label_values(homelab_mttr_seconds, platform)`), `probe` (multi-select)
- All panels use the dashboard's selected `${platform}` / `${probe}` template variables in their queries.

The README that ships with the plugin documents the import flow: Grafana → Dashboards → New → Import → upload `homelab.json` → select Prometheus datasource.

## Acceptance Criteria

- [ ] Each metric emitter produces a structured event with the canonical metric name (`homelab_mttr_seconds`, `homelab_fp_rate`, `homelab_gate_latency_seconds`, `homelab_bypass_attempts_total`); verified by spying on the metrics-pipeline client.
- [ ] `emitMTTR`, `emitGateLatency`, `emitBypassAttempt` survive metric-pipeline failures: a thrown error inside the client is logged at WARN and the function returns normally (no propagation).
- [ ] `emitFPRate` increments persisted counters at `<homelab-data>/metrics-fp-counters.json` and emits the rolling 7d ratio with each call; counters survive daemon restart.
- [ ] `clockStore.start` rejects duplicate (kind, key) with `ClockAlreadyRunning`.
- [ ] `clockStore` clocks survive daemon restart (verified by writing a clock, restarting the test process, calling `stop` and getting the original `startedAt`).
- [ ] `clockStore.purgeStale(7d)` returns the count of clocks older than 7 days; with `0` arg it returns the count without removing (dry-run).
- [ ] `promoter.ts` calls `clockStore.start('mttr', ...)` after every successful intake submission and `emitFPRate(probe, true)` on cancel.
- [ ] `gate.ts` calls `clockStore.start('gate-latency', ...)` at the top of `gateApproval`; on completion emits both `emitGateLatency` AND `clockStore.stop`.
- [ ] `gate.ts` emits `emitMTTR` ONLY when the action resolves (success or rollback), never on gate-only completion.
- [ ] `typed-confirm.ts` emits `bypass-attempt` with `reason: 'wrong-confirm'` when input is anything other than the literal `CONFIRM`.
- [ ] `validator.ts` emits `bypass-attempt` with `reason: 'config-below-floor'` immediately before throwing `ConfigurationError`.
- [ ] `validator.ts` emits `bypass-attempt` with `reason: 'missing-admin'` when a non-admin attempts the typed-CONFIRM admin-bypass path.
- [ ] `GET /portal/homelab` returns 200 with HTML containing all five `<section>` IDs: `inventory`, `observations`, `pending-actions`, `migrations`, `audit`.
- [ ] Each `/portal/homelab/api/<resource>` endpoint returns JSON whose schema matches the documented contract (verified by JSON schema fixtures).
- [ ] `/portal/homelab/sse` emits `observation.new` events when a new observation is written to `<homelab-data>/observations/`; client receives the event within 5s (verified by mocked file-watcher fixture).
- [ ] Portal panel is READ-ONLY: HTML contains zero `<form>`, `<button type="submit">`, or `fetch(..., { method: 'POST' })` calls in client JS (verified by static scan).
- [ ] Last-update timestamp updates on every SSE event received by the client.
- [ ] `homelab metrics show` (no flags) prints all four metrics in a summary table with 30-day trend.
- [ ] `homelab metrics show --metric mttr` prints MTTR breakdown by platform × pattern (verified by capturing stdout against a fixture metrics dataset).
- [ ] `homelab metrics show --json` produces valid JSON parseable by `jq` (verified by piping in test).
- [ ] `homelab metrics show` includes `orphaned_clocks` in the summary footer when any clock has been pending > 7 days.
- [ ] `homelab portal` constructs `<base_url>/portal/homelab` and opens it via `open` / `xdg-open` (verified by spying on the spawn call).
- [ ] `homelab portal --no-open` prints the URL and returns exit 0.
- [ ] `homelab portal` returns exit 1 when the portal health probe fails.
- [ ] `dashboards/homelab.json` is valid Grafana JSON: parses with `jq -e .` exit 0, contains exactly 5 `panels[]` entries, each panel's `targets[].expr` matches the canonical metric name.
- [ ] Operator can import `homelab.json` via Grafana UI → Dashboards → New → Import without errors (manual smoke documented in PR description).

## Dependencies

- **autonomous-dev TDD-007 / PLAN-007-X**: metrics pipeline client `@autonomous-dev/metrics` exposing histogram/gauge/counter primitives.
- **autonomous-dev PLAN-013-3 / PLAN-014 / PLAN-015-1**: portal server, route registration, SSE channel.
- **PLAN-002-1** (existing): `Observation`, `ObservationPromoter`, observation-cancel path, observation state files.
- **PLAN-002-2** (existing): `gateApproval`, `typedConfirmModal`, `validateOperatorConfig`, pending-action and migration state files, audit event writer.
- **PLAN-001-1** (existing): inventory state file at `<homelab-data>/inventory.json`.
- **No new npm packages** introduced (relies on the runtime's `fetch`, file system, and the existing metrics client).

## Notes
- Read-only portal is a deliberate safety choice consistent with TDD-002 §8: any state-mutating operation must go through the CLI's typed-CONFIRM path so the audit trail captures operator identity. The portal's role is observation; the CLI's role is action.
- Metric names are STABLE across plugin versions until a major bump. The `homelab.json` dashboard ships alongside the plugin so operators always have a matching version; major plugin upgrades carry a "re-import dashboard" note.
- The clock store is intentionally separate from the metrics pipeline because the pipeline does not provide cross-process state for in-flight measurements. Persisting clock starts to disk is what makes daemon restart safe.
- `emitFPRate` aggregates locally rather than delegating to the pipeline because the rolling 7d ratio needs both numerator (false positives) and denominator (total observations) which the pipeline does not retain across restarts in the operator's own deployment.
- The portal's SSE stream is single-direction (server → client). The client never POSTs back; all read endpoints are idempotent GETs. This simplifies auth and matches autonomous-dev portal's existing pattern (PLAN-015-1).
- Bypass-attempt counter is gameable in principle — an admin operator can edit the local `metrics-fp-counters.json` to clear it. Mitigation (per PLAN-002-3 risk register) is that the counter is ALSO emitted to the TDD-007 pipeline, which the operator cannot easily clear cloud-side.
- Orphaned-clock surfacing in the CLI is a debugging aid for operators chasing stuck observations; it is not an error condition by itself.
