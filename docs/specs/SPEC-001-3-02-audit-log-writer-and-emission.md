# SPEC-001-3-02: Homelab Audit Log Writer + Destructive-Op Emission

## Metadata
- **Parent Plan**: PLAN-001-3
- **Tasks Covered**: Task 3 (implement audit log writer), Task 4 (wire audit-log emission into all destructive operations)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev-homelab/docs/specs/SPEC-001-3-02-audit-log-writer-and-emission.md`

## Description
Build the homelab plugin's tamper-evident audit log per TDD-001 §12, reusing the HMAC-chained JSONL pattern already established by autonomous-dev's PLAN-019-4. The writer lives at `<homelab-data>/audit.log`; each line is one JSON entry containing event metadata plus an HMAC over `(prev_hmac || serialized_entry)`. Concurrent writers serialize through a per-file mutex. The signing key (`HOMELAB_AUDIT_KEY`) auto-generates on first run with mode `0600`; subsequent runs read it back. After the writer exists, wire emission into every destructive operation already shipped by PLAN-001-1 and PLAN-001-2: consent grant/revoke, CA init/rotate, cert sign/revoke, connection open/close (success and failure), and command exec.

This spec does not implement the `audit verify` or `audit query` CLI subcommands (those are in SPEC-001-3-03), and it does not enforce admin authentication on emitting code paths (covered in SPEC-001-3-04). It produces the writer and the emission call sites only.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-homelab/src/audit/writer.ts` | Create | `AuditWriter` class with `append`, `getLastHmac`, `getKey` |
| `plugins/autonomous-dev-homelab/src/audit/types.ts` | Create | `AuditEvent`, `AuditEntry`, event-type union |
| `plugins/autonomous-dev-homelab/src/audit/key-store.ts` | Create | Loads or generates `HOMELAB_AUDIT_KEY` with mode `0600` |
| `plugins/autonomous-dev-homelab/src/consent/manager.ts` | Modify | Emit `consent_granted` / `consent_revoked` |
| `plugins/autonomous-dev-homelab/src/ca/manager.ts` | Modify | Emit `ca_initialized`, `ca_rotated`, `cert_signed`, `cert_revoked` |
| `plugins/autonomous-dev-homelab/src/connection/base.ts` | Modify | Emit `connection_opened`, `connection_failed`, `connection_closed` |
| `plugins/autonomous-dev-homelab/src/connection/pool.ts` | Modify | Emit `command_executed` (per exec call, success or failure) |
| `plugins/autonomous-dev-homelab/src/cli/commands/discover.ts` | Modify | Emit `discovery_started` and `discovery_completed` |

## Implementation Details

### `AuditEntry` Shape

```typescript
export type AuditEventType =
  | 'discovery_started' | 'discovery_completed'
  | 'consent_granted' | 'consent_revoked'
  | 'ca_initialized' | 'ca_rotated'
  | 'cert_signed' | 'cert_revoked'
  | 'connection_opened' | 'connection_failed' | 'connection_closed'
  | 'command_executed'
  | 'audit_key_rotated';

export interface AuditEntry {
  /** Monotonic counter, starts at 1. */
  seq: number;
  /** ISO-8601 with millisecond precision. */
  timestamp: string;
  /** OS user that initiated the action (e.g., 'pwatson'). */
  actor: string;
  /** Optional inventoried platform id, if relevant. */
  platform: string | null;
  event: AuditEventType;
  /** Event-specific structured data. */
  payload: Record<string, unknown>;
  /** hex(HMAC-SHA256(key, prev_hmac || canonical_json_of_above_fields)) */
  hmac: string;
}
```

The "above fields" excludes `hmac` itself. Use canonical JSON (sorted keys, no whitespace) for deterministic HMAC input.

### `AuditWriter` Contract

```typescript
export class AuditWriter {
  constructor(
    private readonly logPath: string,    // <homelab-data>/audit.log
    private readonly keyStore: AuditKeyStore,
  ) {}

  /** Append one entry. Computes seq, timestamp, actor (from process.env.USER), and HMAC. */
  async append(event: AuditEventType, payload: Record<string, unknown>, opts?: {
    platform?: string | null;
    actor?: string;       // Override (mainly for tests / system actions).
  }): Promise<AuditEntry>;

  /** Returns the last entry's HMAC, or zero-bytes hex if file is empty/missing. */
  async getLastHmac(): Promise<string>;

  /** For testing: returns the in-memory mutex queue depth. */
  pendingWrites(): number;
}
```

Behavior:
1. All `append` calls go through a per-instance `Mutex` (use `async-mutex` or hand-rolled `Promise` chain). Concurrent calls are serialized in submission order.
2. Each `append`:
   a. Acquires the mutex.
   b. Reads `prev_hmac` (from in-memory cache or last line of `audit.log` if cache cold).
   c. Builds the entry minus `hmac`. Computes `seq = prev_seq + 1` (or `1` if file empty).
   d. Computes `hmac = hex(HMAC-SHA256(key, prev_hmac || canonical_json(entry)))`.
   e. Appends `JSON.stringify(entry) + '\n'` with `fs.promises.appendFile`.
   f. Updates the in-memory cache (`prev_hmac`, `prev_seq`).
   g. Releases the mutex.
3. On daemon restart: the first `getLastHmac` call streams the file backwards (read the last 4 KiB, find the final newline, parse the trailing line) to recover state without loading the whole log. If the log is missing, treat as empty.
4. Errors: a write failure (disk full, permission denied) propagates as a thrown `AuditWriteError` to the caller, but the mutex is always released. The caller decides whether to abort the destructive operation or proceed (by default: abort).

### `AuditKeyStore`

```typescript
export class AuditKeyStore {
  constructor(private readonly keyPath: string) {} // <homelab-data>/.audit-key

  /** Returns the 32-byte key (Buffer). Generates and persists if missing. */
  async getKey(): Promise<Buffer>;
}
```

Key file format: 64 hex characters + trailing newline. On generation: `crypto.randomBytes(32)`, write with `fs.promises.writeFile(keyPath, hex + '\n', { mode: 0o600 })`. Verify mode after read; warn if not `0600` (do not auto-fix — the operator may have intentionally tightened/loosened).

### Emission Call Sites

For each modified file, the emission is a single new call inserted **after** the destructive action commits (so failed actions are NOT recorded as success but ARE recorded as failure).

Examples (illustrative; exact structure follows the file's existing style):

```typescript
// In consent/manager.ts after grant:
await this.auditWriter.append('consent_granted', {
  cidr: req.cidr,
  ports: req.ports,
  scan_types: req.scanTypes,
  expires_at: result.expiresAt,
});

// In ca/manager.ts after revokeKeys:
await this.auditWriter.append('cert_revoked', {
  cert_serial: cert.serial,
  reason: opts.reason ?? 'manual',
}, { platform: cert.platformId });

// In connection/base.ts on failed connect:
await this.auditWriter.append('connection_failed', {
  transport: this.transport,
  error_code: err.code,
  error_message: err.message,
}, { platform: this.platformId });

// In connection/pool.ts after exec:
await this.auditWriter.append('command_executed', {
  command: redactedCommand,    // Redact secrets (see Notes).
  exit_code: result.exitCode,
  duration_ms: result.durationMs,
}, { platform: this.platformId });
```

Every emission is `await`ed — fire-and-forget would risk losing entries on process exit.

### Wiring

`AuditWriter` is constructed once at plugin startup (or per-CLI-invocation) and dependency-injected into:
- `ConsentManager` (constructor param)
- `SSHCertificateManager` (constructor param)
- `Connection` and `ConnectionPool` (constructor param)
- `discover` command handler (passed via the existing context object)

Existing tests for these modules must be updated to inject a stub `AuditWriter` (no real disk writes during unit tests).

## Acceptance Criteria

- [ ] Writing 1000 entries via concurrent `append` calls produces exactly 1000 lines, each with a valid HMAC chain (verified by walking the file).
- [ ] HMAC is `hex(HMAC-SHA256(key, prev_hmac || canonical_json_of_entry_minus_hmac))`. Canonical JSON uses sorted keys and no whitespace.
- [ ] First entry's `prev_hmac` input is 64 zero hex characters (`'0'.repeat(64)`).
- [ ] `seq` is monotonic starting at 1; no gaps even under concurrency.
- [ ] Concurrent `append` calls do not interleave bytes in `audit.log` (verified by check that every line parses cleanly).
- [ ] After a fresh process start, `getLastHmac()` returns the HMAC of the final entry in the existing log (recovered by tail-reading, not whole-file scan).
- [ ] If `audit.log` is missing, `getLastHmac()` returns the zero-string and the next `append` writes seq=1.
- [ ] `AuditKeyStore.getKey()` generates a 32-byte key on first call; persists at `<homelab-data>/.audit-key` with mode `0600`; subsequent calls read the same key.
- [ ] If `.audit-key` exists but has mode != `0600`, a warning is logged (file is still used).
- [ ] After running `discover` + `consent grant 192.168.1.0/24` + `ca init` + `platform install-ca proxmox-01`, the audit log contains entries for each event in chronological order with correct `event`, `actor`, `platform`, and `payload` shape.
- [ ] A failed connection emits `connection_failed` with `error_code` and `error_message` in payload.
- [ ] Every successful `platform exec` emits `command_executed` with the (redacted) command, `exit_code`, and `duration_ms`.
- [ ] If `AuditWriter.append` throws, the calling destructive operation aborts and surfaces the error to the operator (does not silently proceed).
- [ ] Unit test coverage on `audit/writer.ts` and `audit/key-store.ts` ≥ 95%.

## Dependencies

- **Blocked by**: PLAN-001-1 (provides `ConsentManager`, `discover` command), PLAN-001-2 (provides `SSHCertificateManager`, `Connection`, `ConnectionPool`).
- **Consumes pattern from**: autonomous-dev PLAN-019-4 (HMAC-chained audit log; same algorithm).
- **Consumed by**: SPEC-001-3-03 (`audit verify` and `audit query` CLI), PLAN-002-* (every observation/fix-action emits to this log).
- Node.js `crypto` (HMAC-SHA256), `fs/promises`. Optional `async-mutex` library.

## Notes

- The HMAC chain matches autonomous-dev's existing pattern exactly so operators familiar with the autonomous-dev audit log have zero learning curve. Where any divergence is unavoidable (e.g., the `platform` field is homelab-specific), it is additive — the field is `null` for events without a relevant platform.
- **Command redaction**: `command_executed` payloads must redact obvious secrets. Use a regex pass to mask `password=...`, `--token <X>`, `Authorization: Bearer ...`, and base64-looking tokens longer than 20 chars. Document this in the operator guide; the redaction is best-effort, not a security boundary.
- **Audit-key loss recovery**: If `.audit-key` is deleted or corrupt, the writer regenerates it. All entries written before the regeneration become unverifiable (HMAC mismatch). A `audit_key_rotated` entry is the first entry written under the new key, with payload `{ reason: 'previous_key_unavailable' }`. Operators are warned at startup. This matches PLAN-019-4's behavior.
- **Performance**: With the mutex, sustained throughput is ~10K appends/sec on SSD. Adequate for homelab workloads (peak ~100/sec under heavy operator activity). If contention becomes an issue, batch writes are a future enhancement.
- **Log rotation**: Out of scope here. PLAN-019-4's rotation logic applies (audit log rotated alongside other plugin logs); homelab-specific rotation tooling is a future concern.
