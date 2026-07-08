/**
 * Backup execution engine. Issue #45.
 *
 * Provides a `BackupDriver` interface + open-string registry. Each driver
 * is keyed by a `targetType` string (e.g. "postgres", "docker-volume",
 * "zfs-dataset"), executes a backup over a `Connection`, writes the
 * artifact to a configurable destination directory, and records a signed
 * manifest entry via `appendManifestEntry`.
 *
 * Concrete drivers included:
 *   postgres      — pg_dump to SQL file
 *   redis         — BGSAVE + copy RDB file
 *   docker-volume — tar of the named volume via docker run
 *   unraid-share  — rsync/tar of an Unraid share path
 *   filesystem    — tar of an arbitrary filesystem path
 *   zfs-dataset   — zfs snapshot + send to file
 *   proxmox-vm    — vzdump of a VM/CT by VMID
 *   opensearch    — OpenSearch snapshot API (curl)
 *   neo4j         — neo4j-admin database dump
 *   vault-raft    — vault operator raft snapshot
 *
 * Invariant #62 compliance: drivers are registered by open string; targets
 * are derived from graph entities (kind=datastore | storage-volume) at
 * call time — no hard-coded instance names.
 *
 * No plaintext secrets are written to manifests or logs.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Connection } from '../connection/base.js';
import type { BackupManifestEntry } from './types.js';
import { signManifestEntry } from './manifest-hmac.js';
import { appendManifestEntry } from './manifest-io.js';
import { DEFAULT_FRESHNESS, FALLBACK_MAX_AGE_SECONDS } from './freshness-rules.js';

// ---------------------------------------------------------------------------
// BackupDriver interface
// ---------------------------------------------------------------------------

/** Input supplied to a driver's `backup` method. */
export interface BackupDriverInput {
  /** Logical target id — used as `target_id` in the manifest entry. */
  targetId: string;
  /**
   * Platform type string — used as `platform` in the manifest entry.
   * Derived from the graph entity's `platformId` or `kind`; never hard-coded.
   */
  platform: string;
  /**
   * Driver-specific configuration (e.g. database name, volume name, path).
   * All values must be safe to pass on a shell command line.
   */
  params: Record<string, string>;
  /** Directory to write the backup artifact into. */
  destDir: string;
  /** Data dir for the manifest file. */
  dataDir: string;
  /** Live connection to the target host. */
  connection: Connection;
}

/** Result returned by a driver's `backup` method. */
export interface BackupDriverResult {
  /** Path to the written artifact (may be on the remote or local dest). */
  artifactPath: string;
  /** Size of the artifact in bytes (0 when the driver cannot determine it). */
  sizeBytes: number;
  /** SHA-256 hex checksum of the artifact (empty when not computed). */
  checksum: string;
  /** The signed manifest entry appended to the manifest. */
  entry: BackupManifestEntry;
}

/**
 * A backup driver. Each driver implements `backup` for one `targetType`.
 * Drivers are registered in the global registry and dispatched by
 * `runBackup`.
 */
export interface BackupDriver {
  /** Human-readable name for log/plan output. */
  readonly name: string;
  /** Open-string target type key (e.g. "postgres"). */
  readonly targetType: string;
  /**
   * Execute the backup. MUST:
   *   - Run commands over `input.connection.exec(...)` only.
   *   - Write the artifact to `input.destDir/<filename>`.
   *   - Return `artifactPath`, `sizeBytes`, `checksum`.
   *   - NOT log secrets.
   * The engine signs the manifest entry; drivers must not call
   * `signManifestEntry` themselves.
   */
  backup(input: BackupDriverInput): Promise<Pick<BackupDriverResult, 'artifactPath' | 'sizeBytes' | 'checksum'>>;
}

// ---------------------------------------------------------------------------
// Driver registry
// ---------------------------------------------------------------------------

const _registry = new Map<string, BackupDriver>();

/**
 * Registers a backup driver for `driver.targetType`. Overwrites any
 * previously-registered driver with the same key (last-write-wins so
 * callers can override built-ins in tests).
 *
 * @param driver - Driver implementation to register.
 */
export function registerDriver(driver: BackupDriver): void {
  _registry.set(driver.targetType, driver);
}

/**
 * Returns the registered driver for `targetType`, or `undefined` when
 * none is registered.
 *
 * @param targetType - Open string key (e.g. "postgres").
 */
export function getDriver(targetType: string): BackupDriver | undefined {
  return _registry.get(targetType);
}

/** Returns a copy of all registered driver target-type keys. */
export function listDriverTypes(): string[] {
  return [..._registry.keys()];
}

// ---------------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------------

/**
 * Runs a backup for the given target using the registered driver, then
 * appends a signed manifest entry to the manifest file.
 *
 * @param targetType - Key to look up in the driver registry.
 * @param input      - Backup parameters including connection and destDir.
 * @returns The driver result including the signed manifest entry.
 * @throws Error when no driver is registered for `targetType` or when the
 *         driver's `backup` method throws.
 */
export async function runBackup(
  targetType: string,
  input: BackupDriverInput,
): Promise<BackupDriverResult> {
  const driver = _registry.get(targetType);
  if (driver === undefined) {
    throw new Error(
      `No backup driver registered for targetType="${targetType}". ` +
        `Registered types: ${[..._registry.keys()].join(', ') || '(none)'}`,
    );
  }

  const driverResult = await driver.backup(input);

  const maxAge =
    DEFAULT_FRESHNESS[input.platform] ?? FALLBACK_MAX_AGE_SECONDS;

  const unsigned: Omit<BackupManifestEntry, 'hmac'> = {
    schema_version: 2,
    platform: input.platform,
    target_id: input.targetId,
    backup_type: targetType,
    taken_at: new Date().toISOString(),
    location: driverResult.artifactPath,
    size_bytes: driverResult.sizeBytes,
    max_age_seconds: maxAge,
    checksum: driverResult.checksum,
    verified: false,
  };

  const entry = signManifestEntry(unsigned);
  await appendManifestEntry(input.dataDir, entry);

  return { ...driverResult, entry };
}

// ---------------------------------------------------------------------------
// Utility: exec + capture stdout
// ---------------------------------------------------------------------------

/**
 * Executes `command` on `connection` and returns stdout. Throws when the
 * exit code is non-zero, including stderr in the error message.
 * Never logs secrets.
 */
async function execOrThrow(connection: Connection, command: string): Promise<string> {
  const result = await connection.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
  }
  return result.stdout;
}

/**
 * Parse a size string like "1234" or "1234 bytes" from remote stat output.
 * Returns 0 when the format is not recognized.
 */
function parseSizeOutput(raw: string): number {
  const m = raw.trim().match(/^(\d+)/);
  return m !== null && m !== undefined && m[1] !== undefined ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Concrete driver implementations
// ---------------------------------------------------------------------------

/** postgres driver: pg_dump → SQL file in destDir. */
const postgresDriver: BackupDriver = {
  name: 'PostgreSQL pg_dump',
  targetType: 'postgres',
  async backup(input) {
    const dbName = input.params['db'] ?? input.targetId;
    const fileName = `pg-${dbName}-${Date.now()}.sql.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    // No secrets in command: pg_dump uses PGPASSWORD env (set by the host's
    // environment / Vault-materialized .pgpass, NOT captured here).
    await execOrThrow(
      input.connection,
      `pg_dump ${dbName} | gzip > ${destPath}`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** redis driver: BGSAVE then copy the RDB file. */
const redisDriver: BackupDriver = {
  name: 'Redis BGSAVE',
  targetType: 'redis',
  async backup(input) {
    const rdbPath = input.params['rdb_path'] ?? '/var/lib/redis/dump.rdb';
    const fileName = `redis-${input.targetId}-${Date.now()}.rdb`;
    const destPath = path.posix.join(input.destDir, fileName);
    // Trigger BGSAVE and wait for completion.
    await execOrThrow(input.connection, `redis-cli BGSAVE`);
    await execOrThrow(
      input.connection,
      `while [ "$(redis-cli LASTSAVE)" = "$(redis-cli LASTSAVE)" ] && redis-cli BGSAVE 2>&1 | grep -q 'Background saving'; do sleep 1; done`,
    );
    await execOrThrow(input.connection, `cp ${rdbPath} ${destPath}`);
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** docker-volume driver: tar of named Docker volume via transient container. */
const dockerVolumeDriver: BackupDriver = {
  name: 'Docker volume tar',
  targetType: 'docker-volume',
  async backup(input) {
    const volumeName = input.params['volume'] ?? input.targetId;
    const fileName = `docker-vol-${volumeName}-${Date.now()}.tar.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(
      input.connection,
      `docker run --rm -v ${volumeName}:/data -v ${input.destDir}:/backup busybox tar czf /backup/${fileName} -C /data .`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** unraid-share driver: rsync + tar of an Unraid share path. */
const unraidShareDriver: BackupDriver = {
  name: 'Unraid share tar',
  targetType: 'unraid-share',
  async backup(input) {
    const sharePath = input.params['path'] ?? `/mnt/user/${input.targetId}`;
    const fileName = `unraid-share-${input.targetId}-${Date.now()}.tar.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(
      input.connection,
      `tar czf ${destPath} -C ${sharePath} .`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** filesystem driver: tar of an arbitrary path. */
const filesystemDriver: BackupDriver = {
  name: 'Filesystem tar',
  targetType: 'filesystem',
  async backup(input) {
    const srcPath = input.params['path'] ?? `/${input.targetId}`;
    const fileName = `fs-${input.targetId}-${Date.now()}.tar.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(
      input.connection,
      `tar czf ${destPath} -C ${srcPath} .`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** zfs-dataset driver: zfs snapshot + send to compressed file. */
const zfsDatasetDriver: BackupDriver = {
  name: 'ZFS snapshot send',
  targetType: 'zfs-dataset',
  async backup(input) {
    const dataset = input.params['dataset'] ?? input.targetId;
    const snapName = `${dataset}@backup-${Date.now()}`;
    const fileName = `zfs-${dataset.replace(/\//g, '-')}-${Date.now()}.zfs.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(input.connection, `zfs snapshot ${snapName}`);
    await execOrThrow(
      input.connection,
      `zfs send ${snapName} | gzip > ${destPath}`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** proxmox-vm driver: vzdump of a VM/CT. */
const proxmoxVmDriver: BackupDriver = {
  name: 'Proxmox vzdump',
  targetType: 'proxmox-vm',
  async backup(input) {
    const vmid = input.params['vmid'] ?? input.targetId;
    const fileName = `proxmox-vm-${vmid}-${Date.now()}.vma.gz`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(
      input.connection,
      `vzdump ${vmid} --compress gzip --dumpdir ${input.destDir} --mode stop`,
    );
    // vzdump names the file itself; find the latest .vma.gz in destDir.
    const listOut = await execOrThrow(
      input.connection,
      `ls -t ${input.destDir}/*.vma.gz 2>/dev/null | head -1`,
    );
    const actualPath = listOut.trim() || destPath;
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${actualPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${actualPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: actualPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** opensearch driver: snapshot via curl to the snapshot API. */
const opensearchDriver: BackupDriver = {
  name: 'OpenSearch snapshot',
  targetType: 'opensearch',
  async backup(input) {
    const host = input.params['host'] ?? 'localhost:9200';
    const repo = input.params['repo'] ?? 'fs_backup';
    const snapName = `snap-${Date.now()}`;
    // No credentials in params — operator must configure xpack.security
    // via environment / keystore on the host.
    await execOrThrow(
      input.connection,
      `curl -s -X PUT "http://${host}/_snapshot/${repo}/${snapName}?wait_for_completion=true"`,
    );
    const artifactPath = `opensearch://${host}/_snapshot/${repo}/${snapName}`;
    return { artifactPath, sizeBytes: 0, checksum: '' };
  },
};

/** neo4j driver: neo4j-admin database dump. */
const neo4jDriver: BackupDriver = {
  name: 'Neo4j admin dump',
  targetType: 'neo4j',
  async backup(input) {
    const dbName = input.params['db'] ?? 'neo4j';
    const fileName = `neo4j-${dbName}-${Date.now()}.dump`;
    const destPath = path.posix.join(input.destDir, fileName);
    await execOrThrow(
      input.connection,
      `neo4j-admin database dump ${dbName} --to-path=${input.destDir} --overwrite-destination`,
    );
    // neo4j-admin names the file; find it.
    const listOut = await execOrThrow(
      input.connection,
      `ls -t ${input.destDir}/*.dump 2>/dev/null | head -1`,
    );
    const actualPath = listOut.trim() || destPath;
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${actualPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${actualPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: actualPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

/** vault-raft driver: vault operator raft snapshot. */
const vaultRaftDriver: BackupDriver = {
  name: 'Vault raft snapshot',
  targetType: 'vault-raft',
  async backup(input) {
    const fileName = `vault-raft-${Date.now()}.snap`;
    const destPath = path.posix.join(input.destDir, fileName);
    // Vault token is expected to be in VAULT_TOKEN env on the host.
    await execOrThrow(
      input.connection,
      `vault operator raft snapshot save ${destPath}`,
    );
    const sizeRaw = await execOrThrow(input.connection, `stat -c %s ${destPath}`);
    const checksumRaw = await execOrThrow(
      input.connection,
      `sha256sum ${destPath} | awk '{print $1}'`,
    );
    return {
      artifactPath: destPath,
      sizeBytes: parseSizeOutput(sizeRaw),
      checksum: checksumRaw.trim(),
    };
  },
};

// ---------------------------------------------------------------------------
// Register all built-in drivers
// ---------------------------------------------------------------------------

for (const driver of [
  postgresDriver,
  redisDriver,
  dockerVolumeDriver,
  unraidShareDriver,
  filesystemDriver,
  zfsDatasetDriver,
  proxmoxVmDriver,
  opensearchDriver,
  neo4jDriver,
  vaultRaftDriver,
]) {
  registerDriver(driver);
}

// Re-export createHash so tests can compute expected checksums without
// importing node:crypto directly.
export { createHash };
