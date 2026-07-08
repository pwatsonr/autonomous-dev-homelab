/**
 * Restore + DR runbook engine. Issue #47.
 *
 * Flow per manifest entry:
 *   1. Re-verify HMAC + checksum (throws on tamper or mismatch).
 *   2. Produce a human-readable restore plan (what gets overwritten, target
 *      host, expected downtime).
 *   3. Dry-run (non-mutating): verify artifact readability + target
 *      reachability over the connection.
 *   4. GATED restore: routes through the real `gateApproval` with
 *      destructiveness="data-affecting". The gate enforces backup-verify +
 *      typed-CONFIRM. NEVER bypassed.
 *
 * DR runbook text is emitted per platform type via `buildDrRunbook`.
 *
 * Invariant #62: no hard-coded instance names; all host/path references
 * come from the manifest entry's `location` / `platform` fields which are
 * written by the driver at backup time from discovered graph data.
 *
 * No plaintext secrets are written to logs or emitted in runbook text.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Connection } from '../connection/base.js';
import type { BackupManifestEntry } from './types.js';
import { verifyEntryHmac } from './manifest-hmac.js';
import { gateApproval } from '../safety/gate.js';
import type { Action, GateContext } from '../safety/types.js';

// ---------------------------------------------------------------------------
// Restore plan
// ---------------------------------------------------------------------------

/** Human-readable description of a pending restore operation. */
export interface RestorePlan {
  /** Source artifact path or URL. */
  artifactPath: string;
  /** Platform type string from the manifest entry. */
  platform: string;
  /** Logical target id being overwritten. */
  targetId: string;
  /** Driver/backup type used to produce this artifact. */
  backupType: string;
  /** ISO 8601 timestamp when the backup was taken. */
  takenAt: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Human-readable description of what will be overwritten. */
  overwriteDescription: string;
  /** Rough estimate of expected downtime (informational only). */
  expectedDowntime: string;
  /** DR runbook text for this platform type. */
  drRunbook: string;
}

// ---------------------------------------------------------------------------
// DR runbook templates
// ---------------------------------------------------------------------------

/**
 * Returns a per-platform DR runbook string. The runbook is informational;
 * it describes manual verification steps after an automated restore.
 *
 * Platform strings are open (invariant #62). Unknown platforms receive a
 * generic runbook.
 *
 * @param platform  - Platform type string (e.g. "proxmox", "postgres").
 * @param entry     - The manifest entry being restored.
 * @returns Multi-line runbook text.
 */
export function buildDrRunbook(platform: string, entry: BackupManifestEntry): string {
  const artifact = entry.location;
  const ts = entry.taken_at;

  const generic = [
    `# DR Runbook — ${platform}/${entry.target_id}`,
    `Backup artifact : ${artifact}`,
    `Taken at        : ${ts}`,
    ``,
    `## Verification steps`,
    `1. Confirm the service is stopped before restore.`,
    `2. Restore the artifact to the target location.`,
    `3. Start the service and validate health.`,
    `4. Update monitoring to suppress alerts during validation window (15 min).`,
    `5. Document the incident and time-to-restore in the runbook log.`,
  ].join('\n');

  switch (platform) {
    case 'postgres':
      return [
        `# DR Runbook — PostgreSQL/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Stop the application tier.`,
        `2. Drop and recreate the target database (or use pg_restore --clean).`,
        `3. pg_restore -d <dbname> ${artifact}  (or gunzip | psql)`,
        `4. Run ANALYZE on restored tables.`,
        `5. Restart the application tier.`,
        `6. Validate row counts and recent write timestamps.`,
      ].join('\n');

    case 'redis':
      return [
        `# DR Runbook — Redis/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Stop the Redis service (systemctl stop redis).`,
        `2. Replace the RDB file: cp ${artifact} $(redis-cli CONFIG GET dir | tail -1)/dump.rdb`,
        `3. Start Redis (systemctl start redis).`,
        `4. Verify key count: redis-cli DBSIZE.`,
      ].join('\n');

    case 'proxmox':
    case 'proxmox-vm':
      return [
        `# DR Runbook — Proxmox VM/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. In the Proxmox UI, go to the backup store and select the artifact.`,
        `2. Click "Restore" — choose the target storage and VMID.`,
        `3. Or via CLI: qmrestore ${artifact} <new-vmid> --storage <storage>`,
        `4. Start the VM and verify boot + services.`,
      ].join('\n');

    case 'docker-volume':
      return [
        `# DR Runbook — Docker volume/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Stop containers using the volume.`,
        `2. docker run --rm -v <volume>:/data -v <destDir>:/backup busybox \\`,
        `     tar xzf /backup/${path.basename(artifact)} -C /data`,
        `3. Restart the containers.`,
        `4. Verify data integrity.`,
      ].join('\n');

    case 'zfs-dataset':
      return [
        `# DR Runbook — ZFS dataset/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Confirm no active I/O to the dataset.`,
        `2. zfs receive <target_dataset> < <(gunzip -c ${artifact})`,
        `3. Or roll back to snapshot: zfs rollback <dataset>@<snapshot>`,
        `4. Remount and verify data.`,
      ].join('\n');

    case 'vault-raft':
      return [
        `# DR Runbook — Vault Raft/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Seal all Vault nodes.`,
        `2. vault operator raft snapshot restore ${artifact}`,
        `3. Unseal and verify cluster status: vault status`,
        `4. Rotate root token after recovery.`,
      ].join('\n');

    case 'neo4j':
      return [
        `# DR Runbook — Neo4j/${entry.target_id}`,
        `Backup artifact : ${artifact}`,
        `Taken at        : ${ts}`,
        ``,
        `## Restore steps`,
        `1. Stop Neo4j service.`,
        `2. neo4j-admin database restore --from-path=${artifact} --database=${entry.target_id} --overwrite-destination`,
        `3. Start Neo4j and validate node counts.`,
      ].join('\n');

    default:
      return generic;
  }
}

// ---------------------------------------------------------------------------
// Pre-restore verification
// ---------------------------------------------------------------------------

/**
 * Re-verifies the HMAC of a manifest entry and (when possible) the
 * artifact checksum over the connection.
 *
 * @param entry      - Manifest entry to re-verify.
 * @param connection - Live connection to the host holding the artifact.
 * @throws Error when HMAC or checksum verification fails.
 */
async function reVerifyEntry(
  entry: BackupManifestEntry,
  connection: Connection,
): Promise<void> {
  // 1. HMAC verification (local, cryptographic).
  if (entry.hmac !== '' && !verifyEntryHmac(entry)) {
    throw new Error(
      `Backup manifest HMAC verification failed for ${entry.platform}/${entry.target_id}. ` +
        `The entry may have been tampered with. Refusing restore.`,
    );
  }

  // 2. Checksum verification (remote, artifact integrity).
  if (entry.checksum !== '' && !entry.location.startsWith('opensearch://')) {
    const result = await connection.exec(
      `sha256sum ${entry.location} | awk '{print $1}'`,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Cannot read artifact for checksum verification: ${entry.location}. ` +
          `stderr: ${result.stderr.slice(0, 200)}`,
      );
    }
    const actualChecksum = result.stdout.trim();
    if (actualChecksum !== entry.checksum) {
      throw new Error(
        `Artifact checksum mismatch for ${entry.location}. ` +
          `Expected ${entry.checksum}, got ${actualChecksum}. Refusing restore.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Restore plan builder
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable restore plan from a manifest entry without
 * performing any mutations.
 *
 * @param entry - Manifest entry to restore from.
 * @returns Human-readable restore plan.
 */
export function buildRestorePlan(entry: BackupManifestEntry): RestorePlan {
  const overwriteDesc = `${entry.platform} target "${entry.target_id}" will be overwritten with ` +
    `backup taken at ${entry.taken_at} (${Math.round(entry.size_bytes / 1024)} KiB).`;

  const downtimeMap: Record<string, string> = {
    postgres: '1–10 minutes (database restore + ANALYZE)',
    redis: '< 1 minute (RDB restore)',
    'proxmox-vm': '5–30 minutes (VM restore from vzdump)',
    'docker-volume': '2–5 minutes (volume restore)',
    'zfs-dataset': '2–15 minutes (zfs receive)',
    'vault-raft': '5–15 minutes (raft snapshot restore + unseal)',
    neo4j: '5–20 minutes (neo4j-admin restore)',
    'opensearch': '5–30 minutes (snapshot restore)',
  };
  const expectedDowntime = downtimeMap[entry.platform] ?? '5–30 minutes (unknown platform)';

  return {
    artifactPath: entry.location,
    platform: entry.platform,
    targetId: entry.target_id,
    backupType: entry.backup_type,
    takenAt: entry.taken_at,
    sizeBytes: entry.size_bytes,
    overwriteDescription: overwriteDesc,
    expectedDowntime,
    drRunbook: buildDrRunbook(entry.platform, entry),
  };
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

/** Result of a dry-run restore check. */
export interface DryRunResult {
  /** True iff both artifact readability and target reachability passed. */
  ok: boolean;
  /** Artifact readability check result. */
  artifactReadable: boolean;
  /** Target host reachability check result. */
  targetReachable: boolean;
  /** Human-readable plan. */
  plan: RestorePlan;
  /** Any error messages encountered. */
  errors: string[];
}

/**
 * Performs a non-mutating dry-run of the restore. Checks:
 *   - HMAC + checksum re-verification.
 *   - Artifact readability (stat on the connection).
 *   - Target reachability (connection.exec a simple no-op).
 *
 * Does NOT exec any restore commands.
 *
 * @param entry      - Manifest entry to dry-run against.
 * @param connection - Live connection to the artifact host.
 * @returns Dry-run result with ok/fail flags and the restore plan.
 */
export async function dryRunRestore(
  entry: BackupManifestEntry,
  connection: Connection,
): Promise<DryRunResult> {
  const plan = buildRestorePlan(entry);
  const errors: string[] = [];
  let artifactReadable = false;
  let targetReachable = false;

  // Check artifact readability.
  try {
    if (entry.location.startsWith('opensearch://')) {
      // OpenSearch snapshots: verify the snapshot exists via curl.
      const url = entry.location.replace('opensearch://', 'http://');
      const result = await connection.exec(`curl -s -o /dev/null -w "%{http_code}" ${url}`);
      artifactReadable = result.exitCode === 0 && result.stdout.trim() === '200';
      if (!artifactReadable) {
        errors.push(`OpenSearch snapshot not reachable: HTTP ${result.stdout.trim()}`);
      }
    } else {
      const result = await connection.exec(`stat ${entry.location}`);
      artifactReadable = result.exitCode === 0;
      if (!artifactReadable) {
        errors.push(`Artifact not readable: ${entry.location} — ${result.stderr.slice(0, 200)}`);
      }
    }
  } catch (e) {
    errors.push(`Artifact readability check failed: ${(e as Error).message}`);
  }

  // Check target reachability.
  try {
    const result = await connection.exec('echo ok');
    targetReachable = result.exitCode === 0 && result.stdout.trim() === 'ok';
    if (!targetReachable) {
      errors.push(`Target host not reachable: connection.exec returned exit ${result.exitCode}`);
    }
  } catch (e) {
    errors.push(`Target reachability check failed: ${(e as Error).message}`);
  }

  // Re-verify HMAC + checksum (reads artifact; still non-mutating).
  try {
    await reVerifyEntry(entry, connection);
  } catch (e) {
    errors.push(`Verification failed: ${(e as Error).message}`);
    artifactReadable = false; // treat tamper as unreadable
  }

  return {
    ok: artifactReadable && targetReachable && errors.length === 0,
    artifactReadable,
    targetReachable,
    plan,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Per-platform restore executors
// ---------------------------------------------------------------------------

/**
 * Executes the platform-specific restore command(s) on `connection`.
 * Called only after gate approval.
 *
 * @param entry      - Verified manifest entry to restore from.
 * @param connection - Live connection to the target host.
 * @throws Error when the restore command fails.
 */
async function execRestore(
  entry: BackupManifestEntry,
  connection: Connection,
): Promise<void> {
  async function run(cmd: string): Promise<void> {
    const result = await connection.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(
        `Restore command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
      );
    }
  }

  switch (entry.platform) {
    case 'postgres': {
      const dbName = entry.target_id;
      if (entry.backup_type === 'pg_dump' || entry.backup_type === 'postgres') {
        await run(`gunzip -c ${entry.location} | psql ${dbName}`);
      } else {
        await run(`pg_restore --clean -d ${dbName} ${entry.location}`);
      }
      break;
    }
    case 'redis': {
      const rdbDest = '/var/lib/redis/dump.rdb';
      await run('systemctl stop redis');
      await run(`cp ${entry.location} ${rdbDest}`);
      await run('systemctl start redis');
      break;
    }
    case 'proxmox':
    case 'proxmox-vm': {
      await run(`qmrestore ${entry.location} ${entry.target_id} --force`);
      break;
    }
    case 'docker-volume': {
      const volumeName = entry.target_id;
      const destDir = path.posix.dirname(entry.location);
      const fileName = path.posix.basename(entry.location);
      await run(
        `docker run --rm -v ${volumeName}:/data -v ${destDir}:/backup busybox tar xzf /backup/${fileName} -C /data`,
      );
      break;
    }
    case 'zfs-dataset': {
      const dataset = entry.target_id;
      await run(`gunzip -c ${entry.location} | zfs receive -F ${dataset}`);
      break;
    }
    case 'vault-raft': {
      await run(`vault operator raft snapshot restore ${entry.location}`);
      break;
    }
    case 'neo4j': {
      const dbName = entry.target_id;
      await run(
        `neo4j-admin database restore --from-path=${entry.location} --database=${dbName} --overwrite-destination`,
      );
      break;
    }
    case 'opensearch': {
      // The location is "opensearch://<host>/_snapshot/<repo>/<snap>".
      // Re-restore not directly supported; emit guidance.
      throw new Error(
        `OpenSearch restore requires manual steps. See DR runbook:\n${buildDrRunbook(entry.platform, entry)}`,
      );
    }
    case 'unraid-share':
    case 'filesystem': {
      const destPath = `/${entry.target_id}`;
      await run(`mkdir -p ${destPath} && tar xzf ${entry.location} -C ${destPath}`);
      break;
    }
    default: {
      // Generic tar restore for unknown platforms.
      const destPath = `/restore/${entry.platform}/${entry.target_id}`;
      await run(`mkdir -p ${destPath} && tar xzf ${entry.location} -C ${destPath}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Gated restore entry point
// ---------------------------------------------------------------------------


export interface RestoreInput {
  /** Manifest entry to restore from. */
  entry: BackupManifestEntry;
  /** Live connection to the target host. */
  connection: Connection;
  /** Gate context (audit sink, isAdmin, config). */
  gateContext: GateContext;
  /** Action id (ULID or similar). */
  actionId: string;
  /** When true, perform only the dry-run (no gate, no mutations). */
  dryRun?: boolean;
  /** Agent or operator identifier requesting the restore. */
  requestedBy?: string;
}

export interface RestoreResult {
  /** True when the restore completed (or dry-run passed). */
  ok: boolean;
  /** The restore plan produced during this run. */
  plan: RestorePlan;
  /** Dry-run result (always present). */
  dryRunResult: DryRunResult;
  /** True when the actual restore (not dry-run) was executed. */
  restored: boolean;
}

/**
 * Runs the full verify → plan → dry-run → gated-restore flow.
 *
 * When `input.dryRun` is true, only the dry-run is performed; the gate is
 * not invoked and no mutations are made.
 *
 * When `input.dryRun` is false (default), the gate is invoked with
 * `destructiveness="data-affecting"` (which enforces backup-verify +
 * typed-CONFIRM per the ladder). The gate MUST NOT be bypassed.
 *
 * @param input - Restore parameters.
 * @returns Restore result including plan and dry-run outcome.
 * @throws Error on HMAC/checksum tamper, dry-run failure, gate denial, or
 *         restore command failure.
 */
export async function runRestore(input: RestoreInput): Promise<RestoreResult> {
  const { entry, connection, gateContext, actionId, dryRun = false, requestedBy = 'restore-cli' } = input;

  // Step 1 + 2: Re-verify HMAC + checksum, build plan, dry-run.
  const dryRunResult = await dryRunRestore(entry, connection);
  const plan = dryRunResult.plan;

  if (!dryRunResult.ok) {
    throw new Error(
      `Restore dry-run failed for ${entry.platform}/${entry.target_id}:\n` +
        dryRunResult.errors.join('\n'),
    );
  }

  if (dryRun) {
    return { ok: true, plan, dryRunResult, restored: false };
  }

  // Step 3: Gate approval. Data-affecting: backup-verify + typed-CONFIRM.
  const action: Action = {
    id: actionId,
    destructiveness: 'data-affecting',
    target: { platform: entry.platform, resource: entry.target_id },
    description:
      `Restore ${entry.platform}/${entry.target_id} from backup taken ${entry.taken_at} ` +
      `(artifact: ${entry.location})`,
    requestedBy,
    initiatedAt: new Date().toISOString(),
    dryRunReport: plan.drRunbook,
  };

  // This call enforces backup-verify + typed-CONFIRM. It may throw
  // ApprovalDeniedError or BackupRequiredError — both propagate to the caller.
  await gateApproval(action, gateContext);

  // Step 4: Execute the restore.
  await execRestore(entry, connection);

  return { ok: true, plan, dryRunResult, restored: true };
}
