/**
 * Unraid deep-discovery enumerator — issue #30.
 *
 * Implements the dynamic-first invariant (issue #62): all entities are derived
 * by parsing live command output over the established SSH connection. No disk
 * names, share names, or job schedules are hard-coded in this file.
 *
 * Entity kinds produced:
 *   storage-array   — the Unraid md RAID array (one per platform)
 *   storage-disk    — each member disk in the array (parsed from mdcmd/disks.ini)
 *   share           — each user share (parsed from shares.ini or *.cfg files)
 *   gpu             — each NVIDIA GPU discovered via nvidia-smi (skipped if absent)
 *   job             — each cron-based scheduled job (mover, parity, user scripts)
 *
 * Edge types produced:
 *   member-of  — disk → array; disk → platform; share → platform; gpu → platform
 *   backed-by  — share → disk (share's includedDisks list)
 *   runs-on    — gpu → platform node
 *
 * All command failures are caught per-category: a missing file or non-zero
 * exit produces an empty contribution for that category and the enumeration
 * continues (graceful degradation).
 *
 * Read-only commands only. No writes to the Unraid host.
 */

import type { PlatformEnumerator, EnumerationContext, EnumerationResult } from '../enumerator.js';
import type { Entity, Edge } from '../graph-types.js';

// ---------------------------------------------------------------------------
// Internal parsed shapes
// ---------------------------------------------------------------------------

/**
 * A disk entry parsed from `mdcmd status` or `/var/local/emhttp/disks.ini`.
 */
interface ParsedDisk {
  /** Slot name (e.g. "disk1", "parity", "cache"). */
  slot: string;
  /** Block device name without /dev/ prefix (e.g. "sda"). */
  device: string;
  /** Disk size in bytes as a string. */
  size: string;
  /** Temperature in Celsius (string from source, may be empty). */
  temp: string;
  /** Array status for this disk (e.g. "DISK_OK", "DISK_NP", "DISK_DSBL"). */
  status: string;
  /** SMART health string ("PASSED" / "FAILED" / "UNKNOWN"). */
  smartHealth: string;
  /** Whether the disk is spun down (true = not spinning). */
  spunDown: boolean;
}

/**
 * The array-level state parsed from `mdcmd status`.
 */
interface ParsedArray {
  /** e.g. "STARTED", "STOPPED", "SYNCING". */
  mdState: string;
  /** Number of invalid disks. */
  mdInvalidSlots: number;
  /** Number of missing parity disks. */
  mdNumDisabled: number;
  /** e.g. "PARITY" | "PARITY2" | "NONE". */
  mdVersion: string;
  /** Sync-check action in progress, if any. */
  mdResyncAction: string;
  /** Sync progress 0-100 (string). */
  mdResyncPos: string;
}

/**
 * A user share parsed from `/var/local/emhttp/shares.ini` or
 * `/boot/config/shares/<name>.cfg`.
 */
interface ParsedShare {
  name: string;
  allocator: string;
  includedDisks: string[];
  excludedDisks: string[];
  cacheUsage: string;
}

/**
 * An NVIDIA GPU device parsed from `nvidia-smi`.
 */
interface ParsedGpu {
  index: string;
  name: string;
  memoryTotal: string;
  driverVersion: string;
  utilizationGpu: string;
  utilizationMemory: string;
}

/**
 * A scheduled cron job.
 */
interface ParsedJob {
  /** Source description (e.g. "/boot/config/plugins/myplugin/myplugin.cron"). */
  source: string;
  /** Cron schedule expression (e.g. "0 2 * * *"). */
  schedule: string;
  /** The command/script that runs. */
  command: string;
  /** Derived human-readable name (basename of command or source file). */
  name: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an INI-style file where sections are `[name]` and body is `KEY=VALUE`.
 *
 * Returns a map of section name → (key → value) record.
 *
 * @param text - Raw file content.
 * @returns Parsed sections map.
 */
export function parseIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let currentSection = '';
  let currentRecord: Record<string, string> = {};

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[([^\]]+)\]/.exec(line);
    if (sectionMatch) {
      if (currentSection !== '') {
        sections.set(currentSection, currentRecord);
      }
      currentSection = sectionMatch[1]?.trim() ?? '';
      currentRecord = {};
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      currentRecord[key] = value;
    }
  }

  if (currentSection !== '') {
    sections.set(currentSection, currentRecord);
  }
  return sections;
}

/**
 * Parse a flat KEY=VALUE file (no sections) such as a `.cfg` share config.
 *
 * @param text - Raw file content.
 * @returns Key-value map.
 */
export function parseFlatKv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1');
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse `mdcmd status` output into a flat key→value map.
 * mdcmd emits lines of `KEY=VALUE` with no sections.
 *
 * @param stdout - Raw stdout from `mdcmd status`.
 * @returns Flat key-value map.
 */
export function parseMdcmd(stdout: string): Record<string, string> {
  return parseFlatKv(stdout);
}

/**
 * Derive disk entries from a `mdcmd status` kv-map.
 *
 * mdcmd uses numeric suffixes: `rdevName.0`, `rdevSize.0`, `rdevTemp.0`,
 * `rdevStatus.0`, `rdevSmartStatus.0`…
 * Slot names come from `diskName.N`.
 *
 * @param kv - Parsed mdcmd output map.
 * @returns Array of parsed disks.
 */
export function diskEntriesFromMdcmd(kv: Record<string, string>): ParsedDisk[] {
  const disks: ParsedDisk[] = [];

  // Find all numeric indices in use by scanning diskName.N keys.
  const indices = new Set<string>();
  for (const key of Object.keys(kv)) {
    const m = /^diskName\.(\d+)$/.exec(key);
    if (m) indices.add(m[1] ?? '');
  }

  for (const idx of Array.from(indices).sort()) {
    const slot = kv[`diskName.${idx}`] ?? '';
    if (slot === '') continue; // empty slot
    const device = kv[`rdevName.${idx}`] ?? '';
    const size = kv[`rdevSize.${idx}`] ?? '';
    const temp = kv[`rdevTemp.${idx}`] ?? '';
    const status = kv[`rdevStatus.${idx}`] ?? '';
    const smartHealth = kv[`rdevSmartStatus.${idx}`] ?? 'UNKNOWN';
    const spunDown = status === 'DISK_NP' || status === 'DISK_NP_DSBL';

    disks.push({ slot, device, size, temp, status, smartHealth, spunDown });
  }

  return disks;
}

/**
 * Derive disk entries from a parsed `/var/local/emhttp/disks.ini` sections map.
 *
 * disks.ini uses sections like `[disk1]`, `[parity]`, `[cache]`.
 * Each section has keys: `device`, `size`, `temp`, `status`, `spinState`, etc.
 *
 * @param sections - Result of parseIni on disks.ini content.
 * @returns Array of parsed disks.
 */
export function diskEntriesFromDisksIni(
  sections: Map<string, Record<string, string>>,
): ParsedDisk[] {
  const disks: ParsedDisk[] = [];
  for (const [slot, attrs] of sections) {
    const device = attrs['device'] ?? '';
    if (device === '') continue; // no device assigned
    const size = attrs['size'] ?? '';
    const temp = attrs['temp'] ?? '';
    const status = attrs['status'] ?? '';
    const smartHealth = attrs['smartStatus'] ?? 'UNKNOWN';
    const spunDown = (attrs['spinState'] ?? attrs['spunDown'] ?? '') === '1';
    disks.push({ slot, device, size, temp, status, smartHealth, spunDown });
  }
  return disks;
}

/**
 * Parse array-level state from the mdcmd kv-map.
 *
 * @param kv - Parsed mdcmd output.
 * @returns Array state summary.
 */
export function arrayStateFromMdcmd(kv: Record<string, string>): ParsedArray {
  return {
    mdState: kv['mdState'] ?? '',
    mdInvalidSlots: parseInt(kv['mdInvalidSlots'] ?? '0', 10),
    mdNumDisabled: parseInt(kv['mdNumDisabled'] ?? '0', 10),
    mdVersion: kv['mdVersion'] ?? '',
    mdResyncAction: kv['mdResyncAction'] ?? '',
    mdResyncPos: kv['mdResyncPos'] ?? '0',
  };
}

/**
 * Parse share entries from a `/var/local/emhttp/shares.ini` sections map.
 *
 * @param sections - Result of parseIni.
 * @returns Array of parsed shares.
 */
export function sharesFromIni(sections: Map<string, Record<string, string>>): ParsedShare[] {
  const shares: ParsedShare[] = [];
  for (const [name, attrs] of sections) {
    const included = (attrs['include'] ?? attrs['shareInclude'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const excluded = (attrs['exclude'] ?? attrs['shareExclude'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    shares.push({
      name,
      allocator: attrs['allocator'] ?? attrs['shareAllocator'] ?? '',
      includedDisks: included,
      excludedDisks: excluded,
      cacheUsage: attrs['cache'] ?? attrs['shareCache'] ?? '',
    });
  }
  return shares;
}

/**
 * Parse a share from a flat-KV `.cfg` file. The filename (without `.cfg`) is
 * the share name.
 *
 * @param name - Share name derived from filename.
 * @param kv - Parsed key-value map from the .cfg file.
 * @returns Parsed share.
 */
export function shareFromCfg(name: string, kv: Record<string, string>): ParsedShare {
  const included = (kv['shareInclude'] ?? kv['include'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const excluded = (kv['shareExclude'] ?? kv['exclude'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return {
    name,
    allocator: kv['shareAllocator'] ?? kv['allocator'] ?? '',
    includedDisks: included,
    excludedDisks: excluded,
    cacheUsage: kv['shareCache'] ?? kv['cache'] ?? '',
  };
}

/**
 * Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output.
 *
 * Expected CSV columns (in order):
 *   index, name, memory.total, driver_version, utilization.gpu, utilization.memory
 *
 * @param stdout - Raw nvidia-smi output.
 * @returns Array of parsed GPUs.
 */
export function parseNvidiaSmi(stdout: string): ParsedGpu[] {
  const gpus: ParsedGpu[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 6) continue;
    gpus.push({
      index: parts[0] ?? '',
      name: parts[1] ?? '',
      memoryTotal: parts[2] ?? '',
      driverVersion: parts[3] ?? '',
      utilizationGpu: parts[4] ?? '',
      utilizationMemory: parts[5] ?? '',
    });
  }
  return gpus;
}

/**
 * Parse crontab-format lines from a cron file body.
 *
 * Lines starting with `#` or that don't match a valid cron entry are skipped.
 * Environment-variable assignment lines (`VAR=val`) are also skipped.
 *
 * @param text - Raw crontab content.
 * @param source - Label for the source file path, used in the entity.
 * @returns Array of parsed job entries.
 */
export function parseCrontab(text: string, source: string): ParsedJob[] {
  const jobs: ParsedJob[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    // Skip environment variable assignments (e.g. PATH=/usr/local/sbin)
    if (/^\w+=/.test(line) && !line.startsWith('@')) continue;

    // Handle @reboot / @daily / @weekly / @monthly / @yearly / @hourly
    const atMatch = /^(@\w+)\s+(.+)$/.exec(line);
    if (atMatch) {
      const cmd = (atMatch[2] ?? '').trim();
      jobs.push({
        source,
        schedule: atMatch[1] ?? '',
        command: cmd,
        name: deriveJobName(cmd, source),
      });
      continue;
    }

    // Standard 5-field cron line
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cmd = (m[2] ?? '').trim();
    jobs.push({
      source,
      schedule: m[1] ?? '',
      command: cmd,
      name: deriveJobName(cmd, source),
    });
  }
  return jobs;
}

/**
 * Derive a human-readable job name from its command and source file.
 *
 * Strips shell wrapper prefixes (su, bash -c, etc.) and uses the basename
 * of the first meaningful path token as the name. Falls back to the source
 * file basename.
 *
 * @param command - The cron command string.
 * @param source - The cron source file path.
 * @returns Short display name.
 */
export function deriveJobName(command: string, source: string): string {
  // Strip common shell wrappers
  const stripped = command
    .replace(/^(\/usr\/local\/sbin\/mover|mover)\b/, 'mover')
    .replace(/^\/usr\/local\/sbin\/mdcmd\s+\S+/, 'mdcmd-parity-check')
    .replace(/^bash\s+-c\s+"?/, '')
    .replace(/^\/bin\/bash\s+"?/, '')
    .replace(/^su\s+\S+\s+/, '');

  // Take the basename of the first word
  const firstToken = stripped.trim().split(/\s+/)[0] ?? '';
  if (firstToken !== '') {
    const base = firstToken.split('/').pop() ?? firstToken;
    if (base !== '') return base;
  }

  // Fall back to cron-file basename
  const srcBase = source.split('/').pop() ?? source;
  return srcBase.replace(/\.cron$/, '');
}

// ---------------------------------------------------------------------------
// Exec helper type
// ---------------------------------------------------------------------------

type ExecFn = (cmd: string) => Promise<{ stdout: string; exitCode: number }>;

// ---------------------------------------------------------------------------
// Category fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the Unraid array state and disk list.
 *
 * Tries `mdcmd status` first; if that fails or produces no disk slots, falls
 * back to reading `/var/local/emhttp/disks.ini` via `cat`.
 *
 * @param exec - Bound exec helper.
 * @returns Parsed array and disks, or null if both sources fail.
 */
async function fetchArrayAndDisks(
  exec: ExecFn,
): Promise<{ array: ParsedArray; disks: ParsedDisk[] } | null> {
  // Try mdcmd status first.
  try {
    const res = await exec('mdcmd status 2>/dev/null');
    if (res.exitCode === 0 && res.stdout.trim() !== '') {
      const kv = parseMdcmd(res.stdout);
      const array = arrayStateFromMdcmd(kv);
      const disks = diskEntriesFromMdcmd(kv);
      if (disks.length > 0) {
        return { array, disks };
      }
    }
  } catch {
    // Fall through to disks.ini
  }

  // Fallback: read disks.ini
  try {
    const res = await exec('cat /var/local/emhttp/disks.ini 2>/dev/null');
    if (res.exitCode === 0 && res.stdout.trim() !== '') {
      const sections = parseIni(res.stdout);
      const disks = diskEntriesFromDisksIni(sections);
      const array: ParsedArray = {
        mdState: 'STARTED',
        mdInvalidSlots: 0,
        mdNumDisabled: 0,
        mdVersion: '',
        mdResyncAction: '',
        mdResyncPos: '0',
      };
      return { array, disks };
    }
  } catch {
    // Both sources failed.
  }

  return null;
}

/**
 * Fetch and parse user shares.
 *
 * Tries `/var/local/emhttp/shares.ini` first; if absent or empty, reads all
 * `*.cfg` files under `/boot/config/shares/`.
 *
 * @param exec - Bound exec helper.
 * @returns Array of parsed shares (may be empty).
 */
async function fetchShares(exec: ExecFn): Promise<ParsedShare[]> {
  // Try shares.ini first.
  try {
    const res = await exec('cat /var/local/emhttp/shares.ini 2>/dev/null');
    if (res.exitCode === 0 && res.stdout.trim() !== '') {
      const sections = parseIni(res.stdout);
      if (sections.size > 0) {
        return sharesFromIni(sections);
      }
    }
  } catch {
    // Fall through to cfg files
  }

  // Fallback: list and read each *.cfg file.
  try {
    const listRes = await exec('ls /boot/config/shares/*.cfg 2>/dev/null');
    if (listRes.exitCode !== 0 || listRes.stdout.trim() === '') return [];

    const files = listRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.endsWith('.cfg'));

    const shares: ParsedShare[] = [];
    for (const filePath of files) {
      try {
        const cfgRes = await exec(`cat "${filePath}" 2>/dev/null`);
        if (cfgRes.exitCode !== 0 || cfgRes.stdout.trim() === '') continue;
        const baseName = filePath.split('/').pop() ?? '';
        const shareName = baseName.replace(/\.cfg$/, '');
        if (shareName === '') continue;
        const kv = parseFlatKv(cfgRes.stdout);
        shares.push(shareFromCfg(shareName, kv));
      } catch {
        // Skip this file.
      }
    }
    return shares;
  } catch {
    return [];
  }
}

/**
 * Fetch and parse NVIDIA GPUs if nvidia-smi is available.
 * Returns empty array if nvidia-smi is absent or exits non-zero.
 *
 * @param exec - Bound exec helper.
 * @returns Array of parsed GPUs (may be empty).
 */
async function fetchGpus(exec: ExecFn): Promise<ParsedGpu[]> {
  try {
    const res = await exec(
      'nvidia-smi --query-gpu=index,name,memory.total,driver_version,utilization.gpu,utilization.memory --format=csv,noheader,nounits 2>/dev/null',
    );
    if (res.exitCode !== 0 || res.stdout.trim() === '') return [];
    return parseNvidiaSmi(res.stdout);
  } catch {
    return [];
  }
}

/**
 * Fetch and parse scheduled cron jobs from:
 *  - `/boot/config/plugins/*.cron` (plugin-specific cron files)
 *  - `/etc/cron.d/*` (system cron drop-in directory)
 *
 * Returns empty array if no cron files are found or all execs fail.
 *
 * @param exec - Bound exec helper.
 * @returns Array of parsed jobs (may be empty).
 */
async function fetchJobs(exec: ExecFn): Promise<ParsedJob[]> {
  const jobs: ParsedJob[] = [];

  // Collect plugin cron files.
  const cronSources: Array<{ cmd: string; source: string }> = [];

  try {
    const pluginCronList = await exec(
      'find /boot/config/plugins -name "*.cron" 2>/dev/null',
    );
    if (pluginCronList.exitCode === 0) {
      for (const filePath of pluginCronList.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')) {
        cronSources.push({ cmd: `cat "${filePath}" 2>/dev/null`, source: filePath });
      }
    }
  } catch {
    // No plugin cron files — continue to system cron.
  }

  // Collect /etc/cron.d drop-ins.
  try {
    const sysCronList = await exec('ls /etc/cron.d/ 2>/dev/null');
    if (sysCronList.exitCode === 0) {
      for (const name of sysCronList.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')) {
        const filePath = `/etc/cron.d/${name}`;
        cronSources.push({ cmd: `cat "${filePath}" 2>/dev/null`, source: filePath });
      }
    }
  } catch {
    // No /etc/cron.d entries.
  }

  // Read and parse each cron source.
  for (const { cmd, source } of cronSources) {
    try {
      const res = await exec(cmd);
      if (res.exitCode !== 0 || res.stdout.trim() === '') continue;
      const parsed = parseCrontab(res.stdout, source);
      jobs.push(...parsed);
    } catch {
      // Skip this file.
    }
  }

  return jobs;
}

// ---------------------------------------------------------------------------
// Enumerator
// ---------------------------------------------------------------------------

/**
 * PlatformEnumerator implementation for Unraid hosts.
 *
 * Enumerates storage array, disks, shares, GPUs, and scheduled jobs via
 * read-only SSH commands. Complies with the dynamic-first invariant (#62):
 * no instance-specific disk names, share names, or job identifiers are
 * hard-coded here. Everything is derived from parsed live command output.
 */
export class UnraidEnumerator implements PlatformEnumerator {
  readonly platformKind = 'unraid';

  /**
   * Enumerate Unraid storage, shares, GPU, and jobs into the inventory graph.
   *
   * Uses the following read-only commands over `ctx.connection.exec`:
   *   - `mdcmd status`            → storage-array + storage-disk entities
   *   - `cat /var/local/emhttp/disks.ini`  → fallback disk source
   *   - `cat /var/local/emhttp/shares.ini` → share entities
   *   - `cat /boot/config/shares/*.cfg`    → fallback share source
   *   - `nvidia-smi ...`          → gpu entities (skipped if absent)
   *   - `find /boot/config/plugins -name "*.cron"` + `cat <file>` → job entities
   *   - `ls /etc/cron.d/` + `cat <file>` → additional job entities
   *
   * @param ctx - Enumeration context with live connection and platform record.
   * @returns Entities and edges derived from Unraid live output.
   */
  async enumerate(ctx: EnumerationContext): Promise<EnumerationResult> {
    const { connection, platform, now } = ctx;
    const pid = platform.id;
    const platformEntityId = `platform:${pid}`;

    const entities: Entity[] = [];
    const edges: Edge[] = [];

    /**
     * Thin wrapper over connection.exec that normalises the return shape.
     * Swallows thrown errors, returning exit code 1 and empty stdout.
     */
    const exec: ExecFn = async (cmd: string) => {
      try {
        const result = await connection.exec(cmd);
        return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 0 };
      } catch {
        return { stdout: '', exitCode: 1 };
      }
    };

    // ------------------------------------------------------------------
    // 1. Storage array + disks
    // ------------------------------------------------------------------
    const arrayAndDisks = await fetchArrayAndDisks(exec);

    // Track entityId by slot/device for share backed-by edges.
    const diskEntityBySlot = new Map<string, string>();
    const diskEntityByDevice = new Map<string, string>();

    if (arrayAndDisks !== null) {
      const { array, disks } = arrayAndDisks;

      // storage-array entity (one per platform)
      const arrayEntityId = `storage-array:${pid}`;
      const arrayEntity: Entity = {
        id: arrayEntityId,
        kind: 'storage-array',
        name: `${platform.host ?? pid} array`,
        attributes: {
          state: array.mdState,
          invalid_slots: array.mdInvalidSlots,
          disabled_disks: array.mdNumDisabled,
          protection: array.mdVersion !== '' ? array.mdVersion : 'UNKNOWN',
          resync_action: array.mdResyncAction,
          resync_position: array.mdResyncPos,
        },
        source: 'unraid',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(arrayEntity);

      // array member-of platform
      edges.push({
        id: `member-of:${arrayEntityId}:${platformEntityId}`,
        from: arrayEntityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });

      // storage-disk entities
      for (const disk of disks) {
        const diskEntityId = `storage-disk:${pid}:${disk.slot}`;
        diskEntityBySlot.set(disk.slot, diskEntityId);
        if (disk.device !== '') {
          diskEntityByDevice.set(disk.device, diskEntityId);
        }

        const diskEntity: Entity = {
          id: diskEntityId,
          kind: 'storage-disk',
          name: disk.slot,
          attributes: {
            device: disk.device,
            slot: disk.slot,
            size_bytes: disk.size,
            temp_celsius: disk.temp,
            status: disk.status,
            smart_health: disk.smartHealth,
            spun_down: disk.spunDown,
          },
          source: 'unraid',
          platformId: pid,
          discovered_at: now,
          last_seen: now,
          status: 'active',
        };
        entities.push(diskEntity);

        // disk member-of array
        edges.push({
          id: `member-of:${diskEntityId}:${arrayEntityId}`,
          from: diskEntityId,
          to: arrayEntityId,
          type: 'member-of',
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });

        // disk member-of platform
        edges.push({
          id: `member-of:${diskEntityId}:${platformEntityId}`,
          from: diskEntityId,
          to: platformEntityId,
          type: 'member-of',
          discovered_at: now,
          last_seen: now,
          status: 'active',
        });
      }
    }

    // ------------------------------------------------------------------
    // 2. Shares
    // ------------------------------------------------------------------
    const shares = await fetchShares(exec);

    for (const share of shares) {
      const shareEntityId = `share:${pid}:${share.name}`;
      const shareEntity: Entity = {
        id: shareEntityId,
        kind: 'share',
        name: share.name,
        attributes: {
          allocator: share.allocator,
          included_disks: share.includedDisks,
          excluded_disks: share.excludedDisks,
          cache_usage: share.cacheUsage,
        },
        source: 'unraid',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(shareEntity);

      // share member-of platform
      edges.push({
        id: `member-of:${shareEntityId}:${platformEntityId}`,
        from: shareEntityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });

      // share backed-by each included disk
      for (const diskSlot of share.includedDisks) {
        const diskEntityId =
          diskEntityBySlot.get(diskSlot) ?? diskEntityByDevice.get(diskSlot);
        if (diskEntityId !== undefined) {
          edges.push({
            id: `backed-by:${shareEntityId}:${diskEntityId}`,
            from: shareEntityId,
            to: diskEntityId,
            type: 'backed-by',
            discovered_at: now,
            last_seen: now,
            status: 'active',
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // 3. GPUs
    // ------------------------------------------------------------------
    const gpus = await fetchGpus(exec);

    for (const gpu of gpus) {
      const gpuEntityId = `gpu:${pid}:${gpu.index}`;
      const gpuEntity: Entity = {
        id: gpuEntityId,
        kind: 'gpu',
        name: gpu.name !== '' ? gpu.name : `GPU ${gpu.index}`,
        attributes: {
          index: gpu.index,
          model: gpu.name,
          memory_total_mib: gpu.memoryTotal,
          driver_version: gpu.driverVersion,
          utilization_gpu_pct: gpu.utilizationGpu,
          utilization_memory_pct: gpu.utilizationMemory,
        },
        source: 'unraid',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(gpuEntity);

      // gpu member-of platform
      edges.push({
        id: `member-of:${gpuEntityId}:${platformEntityId}`,
        from: gpuEntityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });

      // gpu runs-on the platform node
      edges.push({
        id: `runs-on:${gpuEntityId}:${platformEntityId}`,
        from: gpuEntityId,
        to: platformEntityId,
        type: 'runs-on',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });
    }

    // ------------------------------------------------------------------
    // 4. Scheduled jobs
    // ------------------------------------------------------------------
    const jobs = await fetchJobs(exec);

    for (const job of jobs) {
      // Use a base64 slug of the source+schedule+command triple as the stable
      // key to avoid collisions when multiple entries exist in one cron file.
      const stableKey = Buffer.from(`${job.source}:${job.schedule}:${job.command}`)
        .toString('base64')
        .slice(0, 24)
        .replace(/[+/=]/g, '_');
      const jobEntityId = `job:${pid}:${stableKey}`;
      const jobEntity: Entity = {
        id: jobEntityId,
        kind: 'job',
        name: job.name,
        attributes: {
          schedule: job.schedule,
          command: job.command,
          source_file: job.source,
        },
        source: 'unraid',
        platformId: pid,
        discovered_at: now,
        last_seen: now,
        status: 'active',
      };
      entities.push(jobEntity);

      // job member-of platform
      edges.push({
        id: `member-of:${jobEntityId}:${platformEntityId}`,
        from: jobEntityId,
        to: platformEntityId,
        type: 'member-of',
        discovered_at: now,
        last_seen: now,
        status: 'active',
      });
    }

    return { entities, edges };
  }
}
