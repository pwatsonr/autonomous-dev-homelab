# SPEC-002-1-04: ObservationCollector + ObservationPromoter + Persistence + observe CLI

## Metadata
- **Parent Plan**: PLAN-002-1
- **Tasks Covered**: Task 6 (collector w/ cadence scheduling), Task 7 (promoter), Task 8 (persistence + retention), Task 9 (`homelab observe` CLI)
- **Spec Path (future home)**: /Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-002-1-04-collector-promoter-persistence-cli.md
- **Estimated effort**: 12 hours

## Description
Wire the probes into a running system: `ObservationCollector` schedules each probe per its declared cadence, deduplicates findings within a 1-hour window, persists them atomically to disk, and routes them to `ObservationPromoter` which maps each observation to a `request_type` and `destructiveness` via the catalog and submits it to autonomous-dev's intake queue. Add the `homelab observe scan|list|promote` CLI surface that lets operators run probes on demand, query recent observations, and re-promote a deduplicated observation when needed. Daily retention purges observations older than 90 days.

This spec is the integration layer for PLAN-002-1: every prior spec produces parts that this spec assembles. After this spec lands, an operator with platforms inventoried (PLAN-001-1) and connections live (PLAN-001-2) can run `homelab observe scan` and watch a fault flow into the autonomous-dev intake.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/observation/collector.ts` | Create | `ObservationCollector` — scheduling, dedup, persistence orchestration |
| `plugins/autonomous-dev-homelab/src/observation/promoter.ts` | Create | `ObservationPromoter` — catalog mapping + intake CLI invocation |
| `plugins/autonomous-dev-homelab/src/observation/persistence.ts` | Create | Atomic write/read/list/cleanup helpers for `<homelab-data>/observations/` |
| `plugins/autonomous-dev-homelab/src/observation/dedup.ts` | Create | In-memory + disk-backed dedup cache, 1h window |
| `plugins/autonomous-dev-homelab/src/cli/commands/observe.ts` | Create | `observe scan/list/promote` subcommands |
| `plugins/autonomous-dev-homelab/src/cli/index.ts` | Modify | Register `observe` command |
| `plugins/autonomous-dev-homelab/tests/observation/collector.test.ts` | Create | Mocked-timer scheduling + dedup tests |
| `plugins/autonomous-dev-homelab/tests/observation/promoter.test.ts` | Create | Catalog mapping + mocked execFile tests |
| `plugins/autonomous-dev-homelab/tests/observation/persistence.test.ts` | Create | Atomic write, read-back, retention tests |
| `plugins/autonomous-dev-homelab/tests/cli/observe.test.ts` | Create | All three subcommands |

## Implementation Details

### `persistence.ts`

```typescript
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Observation } from "./types.js";

const OBS_DIR = "observations";
const RETENTION_DAYS = 90;

export class ObservationStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string { return join(this.dataDir, OBS_DIR); }

  async save(obs: Observation): Promise<string> {
    await mkdir(this.dir(), { recursive: true });
    const finalPath = join(this.dir(), `${obs.id}.json`);
    const tmp = `${finalPath}.tmp`;
    await writeFile(tmp, JSON.stringify(obs, null, 2), "utf8");
    await rename(tmp, finalPath); // atomic on POSIX
    return finalPath;
  }

  async load(id: string): Promise<Observation> {
    return JSON.parse(await readFile(join(this.dir(), `${id}.json`), "utf8")) as Observation;
  }

  async list(filter: { since?: Date; platform?: string; severity?: string } = {}): Promise<Observation[]> {
    let files: string[];
    try { files = await readdir(this.dir()); } catch { return []; }
    const out: Observation[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const obs = JSON.parse(await readFile(join(this.dir(), f), "utf8")) as Observation;
      if (filter.since && new Date(obs.discovered_at) < filter.since) continue;
      if (filter.platform && obs.platform !== filter.platform) continue;
      if (filter.severity && obs.severity !== filter.severity) continue;
      out.push(obs);
    }
    return out.sort((a, b) => b.discovered_at.localeCompare(a.discovered_at));
  }

  async cleanup(now: Date = new Date()): Promise<number> {
    let files: string[];
    try { files = await readdir(this.dir()); } catch { return 0; }
    const cutoff = now.getTime() - RETENTION_DAYS * 86400_000;
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = join(this.dir(), f);
      const s = await stat(p);
      if (s.mtimeMs < cutoff) { await unlink(p); removed++; }
    }
    return removed;
  }
}
```

### `dedup.ts`

```typescript
import type { Observation } from "./types.js";

export class DedupCache {
  private readonly cache = new Map<string, number>(); // dedupKey → ts ms
  constructor(private readonly windowMs: number = 3600_000) {}

  isDuplicate(obs: Observation, now: number = Date.now()): boolean {
    const key = obs.dedup_key ?? `${obs.platform}:${obs.pattern}:${obs.resource}`;
    const last = this.cache.get(key);
    if (last !== undefined && now - last < this.windowMs) return true;
    this.cache.set(key, now);
    return false;
  }

  /** Rehydrate from persisted observations on startup so dedup survives restarts. */
  hydrate(observations: Observation[], now: number = Date.now()): void {
    for (const obs of observations) {
      const ts = new Date(obs.discovered_at).getTime();
      if (now - ts < this.windowMs) {
        const key = obs.dedup_key ?? `${obs.platform}:${obs.pattern}:${obs.resource}`;
        this.cache.set(key, ts);
      }
    }
  }
}
```

### `collector.ts`

```typescript
import type { Probe, Observation } from "./types.js";
import { DedupCache } from "./dedup.js";
import { ObservationStore } from "./persistence.js";
import type { ObservationPromoter } from "./promoter.js";

const CADENCE_MS: Record<Probe["cadence"], number> = {
  fast: 5 * 60_000,
  medium: 15 * 60_000,
  slow: 60 * 60_000,
  daily: 24 * 60 * 60_000,
};
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export class ObservationCollector {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly probes: Probe[],
    private readonly dedup: DedupCache,
    private readonly store: ObservationStore,
    private readonly promoter: ObservationPromoter,
  ) {}

  async start(): Promise<void> {
    const recent = await this.store.list({ since: new Date(Date.now() - 3600_000) });
    this.dedup.hydrate(recent);
    for (const probe of this.probes) {
      const interval = CADENCE_MS[probe.cadence];
      this.timers.push(setInterval(() => void this.runProbe(probe), interval).unref());
    }
    this.timers.push(setInterval(() => void this.store.cleanup(), CLEANUP_INTERVAL_MS).unref());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** Public for `observe scan` CLI. */
  async runProbe(probe: Probe): Promise<Observation[]> {
    const observations = await probe.scan();
    const fresh: Observation[] = [];
    for (const obs of observations) {
      if (this.dedup.isDuplicate(obs)) continue;
      await this.store.save(obs);
      await this.promoter.promote(obs);
      fresh.push(obs);
    }
    return fresh;
  }

  async runAll(filter?: { platformId?: string }): Promise<Observation[]> {
    const subset = filter?.platformId
      ? this.probes.filter((p) => p.platformId === filter.platformId)
      : this.probes;
    const out: Observation[] = [];
    for (const p of subset) out.push(...(await this.runProbe(p)));
    return out;
  }
}
```

### `promoter.ts`

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Observation, RequestType, Destructiveness } from "./types.js";
import { FAULT_CATALOG } from "./fault-catalog.js";

const exec = promisify(execFile);

export class ObservationPromoter {
  constructor(
    private readonly autonomousDevBin: string = "autonomous-dev",
    private readonly defaultRepo: string = "homelab",
  ) {}

  mapToRequestType(obs: Observation): RequestType {
    return FAULT_CATALOG[obs.pattern].default_request_type;
  }

  mapToDestructiveness(obs: Observation): Destructiveness {
    return FAULT_CATALOG[obs.pattern].destructiveness;
  }

  buildBugReport(obs: Observation): string {
    return [
      `Pattern: ${obs.pattern} on ${obs.resource}`,
      `Platform: ${obs.platform}`,
      `Severity: ${obs.severity}`,
      `Discovered: ${obs.discovered_at}`,
      obs.details ? `Details: ${JSON.stringify(obs.details)}` : "",
    ].filter(Boolean).join("\n");
  }

  async promote(obs: Observation): Promise<void> {
    const requestType = this.mapToRequestType(obs);
    const destructiveness = this.mapToDestructiveness(obs);
    await exec(this.autonomousDevBin, [
      "request", "submit",
      "--type", requestType,
      "--source", "production-intelligence",
      "--repo", this.defaultRepo,
      "--description", this.buildBugReport(obs),
      "--metadata", JSON.stringify({ destructiveness, observation_id: obs.id, severity: obs.severity }),
    ]);
  }
}
```

### `cli/commands/observe.ts`

```
Usage:
  homelab observe scan    [--platform <id>] [--dry-run] [--json]
  homelab observe list    [--since <ISO|duration>] [--platform <id>] [--severity P0|P1|P2] [--json]
  homelab observe promote <observation-id> [--override-type bug|infra|hotfix]
```

- `scan`: invokes `collector.runAll({ platformId })`. With `--dry-run`, runs probes and prints results but does NOT persist or promote.
- `list`: invokes `store.list(filter)`. `--since 1h` parses to `Date(now - 1h)`. Default output is a table; `--json` emits an array.
- `promote`: loads observation by id, bypasses dedup, calls `promoter.promote(obs)`. `--override-type` overrides the catalog mapping for this submission only.

All commands exit 0 on success, 1 on any error. JSON output goes to stdout; logs to stderr.

## Acceptance Criteria

**Persistence**
- [ ] `store.save(obs)` writes via `<id>.json.tmp` then renames; concurrent saves never produce a partial file (verified by torn-write test).
- [ ] `store.load(id)` round-trips an observation byte-for-byte equal under JSON.parse.
- [ ] `store.list({ since })` returns only observations where `discovered_at >= since`, sorted newest-first.
- [ ] `store.list({ platform, severity })` filters correctly; combined filters AND.
- [ ] `store.cleanup(now)` removes files with `mtime < now - 90d` and returns the count removed; files newer than 90d are untouched.

**Dedup**
- [ ] `isDuplicate` returns `false` on first call, `true` on second call within 1h with same `dedup_key`.
- [ ] After 1h + 1ms, the same key is no longer a duplicate.
- [ ] `hydrate(recent)` populates the cache so a fresh process restart still suppresses recent dups.

**Collector scheduling (mocked timers)**
- [ ] After `start()`, fast-cadence probes' `scan` is invoked every 5min ±1s; medium every 15min; slow every 1h; daily every 24h.
- [ ] `stop()` clears all timers; no further `scan` calls happen after stop.
- [ ] The cleanup timer fires once per 24h.

**Collector flow**
- [ ] When a probe emits an observation, collector saves it AND calls `promoter.promote`. Verified with mocked `store` and `promoter`.
- [ ] When the same observation is emitted twice within 1h, the second is suppressed: not saved, not promoted.
- [ ] `runAll({ platformId: "k3s-01" })` filters probes to only those whose `platformId === "k3s-01"`.
- [ ] If a probe throws inside `scan` (after the SPEC-002-1-02 sentinel logic — i.e. an unexpected error), the collector logs and continues with the next probe (no probe failure crashes the loop).

**Promoter**
- [ ] For `pattern: "oom_kill"`: `mapToRequestType` returns `"bug"`, `mapToDestructiveness` returns `"persistent-modifying"`.
- [ ] For `pattern: "zfs_pool_degraded"`: returns `"infra"` and `"data-affecting"`.
- [ ] For `pattern: "cert_expiry_imminent"`: returns `"hotfix"` and `"reversible"`.
- [ ] `promote(obs)` invokes `execFile("autonomous-dev", ["request", "submit", ...])` with `--type`, `--source production-intelligence`, `--repo homelab`, `--description`, `--metadata` (containing `destructiveness`, `observation_id`, `severity`). Verified with mocked `execFile`.
- [ ] If `execFile` rejects (intake CLI absent), `promote` re-throws (collector catches and logs).

**CLI**
- [ ] `homelab observe scan --platform proxmox-01` calls `collector.runAll({ platformId: "proxmox-01" })` and prints the count of fresh observations.
- [ ] `homelab observe scan --dry-run` does NOT call `store.save` or `promoter.promote`; it prints the would-be observations.
- [ ] `homelab observe list --since 1h --severity P0 --json` prints a JSON array filtered correctly; `--since` accepts ISO strings AND simple duration shorthand (`30m`, `1h`, `24h`, `7d`).
- [ ] `homelab observe promote OBS-123` loads the observation and calls `promoter.promote` even if `dedup.isDuplicate` would return true. Exits 1 with a clear message if the id does not exist.
- [ ] `homelab observe promote OBS-123 --override-type infra` overrides the catalog-derived request type for that single submission.
- [ ] All commands accept `--help` and print usage; unknown flags exit 1.

## Dependencies

- SPEC-002-1-01: `Observation`, `FAULT_CATALOG`, `Probe`, JSON schema (used by tests).
- SPEC-002-1-02 + SPEC-002-1-03: all 9 probes (constructed by the collector's caller — typically the plugin bootstrap; this spec accepts an injected array).
- PLAN-001-3: audit log writer — promoter calls audit on every promotion (use existing audit interface; do not duplicate).
- TDD-018 / PLAN-018-3 (autonomous-dev): `autonomous-dev request submit` CLI. Tests mock `execFile`; integration is verified in SPEC-002-1-05.
- Node built-ins: `node:fs/promises`, `node:child_process`, `node:util`. No new npm deps.

## Notes

- `setInterval(...).unref()` keeps the timer from holding the event loop open during tests; `vi.useFakeTimers()` (or jest equivalent) advances them.
- The dedup cache is in-memory + disk-rehydrated. Disk-only persistence of the cache (separate file) is intentionally NOT in scope — rehydrating from observation files is sufficient for our 1h window.
- `--dry-run` short-circuits BOTH save and promote so operators can validate probe behavior without polluting the intake queue. This is the primary safety valve for the "false positive flood" risk listed in the plan.
- The collector accepts probes via constructor injection; bootstrap code (out of this spec's scope) decides which platforms get which probes based on `InventoryManager` (PLAN-001-1).
- `audit log` integration: every save AND every promote MUST emit an audit entry (`event_type: observation.created` and `observation.promoted` respectively). Use the audit writer from PLAN-001-3 — don't reinvent.
- Retention is purely time-based (mtime ≥ 90d). Storage size is not factored — Risks row 5 in the plan flags this as acceptable for now.
- The `--override-type` flag on `promote` MUST log a warning to stderr explaining that this bypasses the catalog mapping and recording who ran it (where audit context is available).
