# SPEC-002-1-02: K8sProbe + DockerProbe

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 3 (K8sProbe), Task 4 (DockerProbe)
- **Spec Path (future home)**: /Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-1-02-k8s-and-docker-probes.md
- **Estimated effort**: 4.5 hours

## Description
Implement the two highest-frequency probes: `K8sProbe` (queries `kubectl get events --field-selector type=Warning -A -o json` and emits `crash_loop` / `oom_kill` observations) and `DockerProbe` (consumes the `docker events --filter event=oom` JSON-line stream and emits `oom_kill` observations). Both probes implement the `Probe` interface from SPEC-002-1-01 and reuse `Connection` subclasses from PLAN-001-2 to actually execute commands on remote hosts. This spec ships the probes plus their unit tests; the collector that schedules them lives in SPEC-002-1-04.

Probes are pure transformers: command in, observations out. They MUST treat connection errors as a single `daemon_heartbeat_stale`-style "platform unreachable" sentinel (per the PLAN risk row) rather than throwing, so the collector can record them without crashing the scan loop. UUID generation and timestamp stamping happen in the probe.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/observation/probes/k8s.ts` | Create | `K8sProbe` class implementing `Probe` |
| `plugins/autonomous-dev-homelab/src/observation/probes/docker.ts` | Create | `DockerProbe` class implementing `Probe` |
| `plugins/autonomous-dev-homelab/src/observation/probes/base.ts` | Create | `BaseProbe` abstract class with shared id/cadence boilerplate + UUID/timestamp helpers |
| `plugins/autonomous-dev-homelab/tests/observation/probes/k8s.test.ts` | Create | Fixture-based tests for K8sProbe |
| `plugins/autonomous-dev-homelab/tests/observation/probes/docker.test.ts` | Create | Fixture-based tests for DockerProbe |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/k8s-events-2backoff-1oom.json` | Create | kubectl JSON output: 2 BackOff + 1 OOMKilled |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/k8s-events-empty.json` | Create | kubectl JSON output: zero warning events |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/k8s-events-noise.json` | Create | kubectl events with reasons NOT in our filter (FailedScheduling, etc.) |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/docker-events-2oom.txt` | Create | Two newline-separated JSON OOM events |
| `plugins/autonomous-dev-homelab/tests/observation/fixtures/docker-events-empty.txt` | Create | Empty stream output |

## Implementation Details

### `base.ts` — Shared probe scaffolding

```typescript
import { randomUUID } from "node:crypto";
import type { Observation, Probe } from "../types.js";

export abstract class BaseProbe implements Probe {
  abstract readonly id: string;
  abstract readonly platformId: string;
  abstract readonly cadence: Probe["cadence"];

  abstract scan(): Promise<Observation[]>;

  protected makeObservation(input: Omit<Observation, "id" | "discovered_at" | "dedup_key">): Observation {
    return {
      id: randomUUID(),
      discovered_at: new Date().toISOString(),
      dedup_key: `${input.platform}:${input.pattern}:${input.resource}`,
      ...input,
    };
  }
}
```

### `k8s.ts` — K8sProbe

```typescript
import { BaseProbe } from "./base.js";
import type { Observation } from "../types.js";
import type { K8sConnection } from "../../connection/k8s.js"; // PLAN-001-2

interface KubectlEvent {
  reason: string;
  count?: number;
  message?: string;
  involvedObject: { kind: string; name: string };
}

export class K8sProbe extends BaseProbe {
  readonly id = "k8s";
  readonly cadence = "fast" as const;

  constructor(private readonly conn: K8sConnection) {
    super();
  }

  get platformId(): string {
    return this.conn.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.conn.exec("kubectl get events --field-selector type=Warning -A -o json");
    } catch (err) {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: "daemon_heartbeat_stale",
          resource: `cluster/${this.platformId}`,
          severity: "P0",
          details: { error: String(err), probe: "k8s", reason: "platform_unreachable" },
        }),
      ];
    }

    const parsed = JSON.parse(raw.stdout) as { items: KubectlEvent[] };
    return parsed.items
      .filter((e) => e.reason === "BackOff" || e.reason === "OOMKilled")
      .map((e) =>
        this.makeObservation({
          platform: this.platformId,
          pattern: e.reason === "OOMKilled" ? "oom_kill" : "crash_loop",
          resource: `${e.involvedObject.kind}/${e.involvedObject.name}`,
          severity: "P1",
          details: { count: e.count ?? 1, message: e.message ?? "" },
        }),
      );
  }
}
```

### `docker.ts` — DockerProbe

```typescript
import { BaseProbe } from "./base.js";
import type { Observation } from "../types.js";
import type { DockerConnection } from "../../connection/docker.js"; // PLAN-001-2

interface DockerOomEvent {
  Type: string;
  Action: string;
  Actor: { Attributes: { name: string; image?: string } };
  time: number;
}

export class DockerProbe extends BaseProbe {
  readonly id = "docker";
  readonly cadence = "fast" as const;

  constructor(private readonly conn: DockerConnection) {
    super();
  }

  get platformId(): string {
    return this.conn.platformId;
  }

  async scan(): Promise<Observation[]> {
    let raw: { stdout: string };
    try {
      raw = await this.conn.exec(
        "docker events --since 5m --until 0m --filter event=oom --format '{{json .}}'",
      );
    } catch (err) {
      return [
        this.makeObservation({
          platform: this.platformId,
          pattern: "daemon_heartbeat_stale",
          resource: `dockerd/${this.platformId}`,
          severity: "P0",
          details: { error: String(err), probe: "docker", reason: "platform_unreachable" },
        }),
      ];
    }

    return raw.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerOomEvent)
      .map((evt) =>
        this.makeObservation({
          platform: this.platformId,
          pattern: "oom_kill",
          resource: `container/${evt.Actor.Attributes.name}`,
          severity: "P1",
          details: { image: evt.Actor.Attributes.image, time: evt.time },
        }),
      );
  }
}
```

### Fixture format examples

`k8s-events-2backoff-1oom.json`:
```json
{
  "items": [
    { "reason": "BackOff", "count": 7, "message": "Back-off restarting failed container", "involvedObject": { "kind": "Pod", "name": "web-7c" } },
    { "reason": "BackOff", "count": 3, "message": "Back-off restarting", "involvedObject": { "kind": "Pod", "name": "api-2d" } },
    { "reason": "OOMKilled", "count": 1, "message": "Container exceeded memory limit", "involvedObject": { "kind": "Pod", "name": "worker-9z" } }
  ]
}
```

`docker-events-2oom.txt`:
```
{"Type":"container","Action":"oom","Actor":{"Attributes":{"name":"redis-1","image":"redis:7"}},"time":1714449600}
{"Type":"container","Action":"oom","Actor":{"Attributes":{"name":"queue-2","image":"rabbit:3"}},"time":1714449612}
```

## Acceptance Criteria

**K8sProbe**
- [ ] `new K8sProbe(conn).id === "k8s"` and `cadence === "fast"`.
- [ ] Given `k8s-events-2backoff-1oom.json` as `conn.exec` stdout, `scan()` returns exactly 3 observations: 2 with `pattern: "crash_loop"`, 1 with `pattern: "oom_kill"`, all `severity: "P1"`.
- [ ] Each observation's `resource` is `<Kind>/<name>` matching the involved object.
- [ ] Each observation has a UUIDv4 `id`, ISO-8601 `discovered_at`, and `dedup_key === "<platformId>:<pattern>:<resource>"`.
- [ ] Given `k8s-events-empty.json`, `scan()` returns `[]`.
- [ ] Given `k8s-events-noise.json` (only FailedScheduling/Unhealthy reasons), `scan()` returns `[]` (the filter excludes them).
- [ ] When `conn.exec` rejects, `scan()` resolves to a single `daemon_heartbeat_stale` observation with `details.reason === "platform_unreachable"` and `details.probe === "k8s"`. No throw.

**DockerProbe**
- [ ] `new DockerProbe(conn).id === "docker"` and `cadence === "fast"`.
- [ ] Given `docker-events-2oom.txt`, `scan()` returns exactly 2 observations, both `pattern: "oom_kill"`, `severity: "P1"`, with `resource === "container/<name>"`.
- [ ] `details.image` is set when present in the event.
- [ ] Given `docker-events-empty.txt`, `scan()` returns `[]`.
- [ ] Trailing whitespace and blank lines in stream output are tolerated (no JSON.parse error).
- [ ] When `conn.exec` rejects, `scan()` resolves to a single `daemon_heartbeat_stale` observation with `details.probe === "docker"`. No throw.

**Both**
- [ ] Coverage ≥90% on each probe file (statements, branches).
- [ ] No probe makes a real network/process call in tests; `conn` is a mock implementing the `exec` method.

## Dependencies

- SPEC-002-1-01: imports `Observation`, `Probe`, `BaseProbe` types and `FAULT_CATALOG` (indirectly — patterns are stringly typed via the union).
- PLAN-001-2: imports `K8sConnection` and `DockerConnection` (interface only — tests mock).
- `node:crypto.randomUUID` (Node ≥18, already required).

## Notes

- We deliberately do NOT enrich observations with catalog metadata (severity/destructiveness) here — the promoter (SPEC-002-1-04) joins with the catalog at promotion time. Keeping probes lean means catalog updates don't require probe rebuilds.
- The `daemon_heartbeat_stale` sentinel for unreachable platforms is reused intentionally; it sits at the bottom of the catalog so any probe failure creates a P0 visible observation. The collector dedups these on the same `<platform>:daemon_heartbeat_stale:<resource>` key.
- Docker output uses the Go-template `{{json .}}` form rather than `--format json` because some Docker versions lack the latter. Fixtures match what the template emits.
- `kubectl` is invoked through the connection (NOT `execFile` directly) so SSH/kubeconfig context comes from the PLAN-001-2 connection layer; tests that mock `conn.exec` get full coverage without touching real binaries.
