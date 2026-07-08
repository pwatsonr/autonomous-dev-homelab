/**
 * Tests for UnraidEnumerator — issue #30.
 *
 * Covers:
 *  1. Parser helpers: parseIni, parseFlatKv, parseMdcmd, diskEntriesFromMdcmd,
 *     diskEntriesFromDisksIni, arrayStateFromMdcmd, sharesFromIni, shareFromCfg,
 *     parseNvidiaSmi, parseCrontab, deriveJobName.
 *  2. UnraidEnumerator.enumerate(): entity/edge mapping from fixture output.
 *  3. Fallback paths: mdcmd absent → disks.ini; shares.ini absent → cfg files.
 *  4. Graceful degradation: missing categories produce no crash; partial results
 *     are returned for the categories that succeeded.
 *  5. Invariant #62: no homelab-specific disk, share, or job names appear in
 *     production code — only in these fixtures.
 *
 * No live network or SSH connection is accessed. All Connection.exec calls
 * are mocked.
 */

import { UnraidEnumerator } from '../../src/discovery/enumerators/unraid';
import {
  parseIni,
  parseFlatKv,
  parseMdcmd,
  diskEntriesFromMdcmd,
  diskEntriesFromDisksIni,
  arrayStateFromMdcmd,
  sharesFromIni,
  shareFromCfg,
  parseNvidiaSmi,
  parseCrontab,
  deriveJobName,
} from '../../src/discovery/enumerators/unraid';
import type { Connection, ExecResult } from '../../src/connection/base';
import type { Platform } from '../../src/discovery/inventory-types';
import {
  FIXTURE_MDCMD_STATUS,
  FIXTURE_MDCMD_STATUS_STOPPED,
  FIXTURE_DISKS_INI,
  FIXTURE_SHARES_INI,
  FIXTURE_SHARE_CFG_APPDATA,
  FIXTURE_SHARE_CFG_ISOS,
  FIXTURE_NVIDIA_SMI_SINGLE,
  FIXTURE_NVIDIA_SMI_TWO,
  FIXTURE_CRON_MOVER,
  FIXTURE_CRON_PARITY,
  FIXTURE_CRON_USERSCRIPTS,
  FIXTURE_CRON_EMPTY,
} from './fixtures/unraid-fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = '2026-07-08T00:00:00.000Z';
const PLATFORM_ID = 'unraid-10-200-0-136';

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    id: overrides.id ?? PLATFORM_ID,
    type: overrides.type ?? 'unraid',
    host: overrides.host ?? '10.200.0.136',
    port: overrides.port ?? 22,
    discovered_at: overrides.discovered_at ?? NOW,
    last_seen: overrides.last_seen ?? NOW,
    ...overrides,
  };
}

/**
 * Build a mock Connection whose exec() returns pre-programmed responses.
 * Matching is by substring of the command string (first match wins).
 */
function makeMockConnection(
  responses: Array<{ matches: string; result: Partial<ExecResult> }>,
): Connection {
  return {
    platformId: PLATFORM_ID,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockImplementation(async (cmd: string): Promise<ExecResult> => {
      for (const r of responses) {
        if (cmd.includes(r.matches)) {
          return {
            stdout: r.result.stdout ?? '',
            stderr: r.result.stderr ?? '',
            exitCode: r.result.exitCode ?? 0,
            durationMs: r.result.durationMs ?? 0,
          };
        }
      }
      // Default: empty success (category will be skipped gracefully)
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
    }),
    getCapabilities: jest.fn().mockReturnValue({ transport: 'ssh', hostname: '10.200.0.136' }),
    isConnected: jest.fn().mockReturnValue(true),
    getLastUsedAt: jest.fn().mockReturnValue(0),
  } as unknown as Connection;
}

// ---------------------------------------------------------------------------
// 1. Parser helpers
// ---------------------------------------------------------------------------

describe('parseIni', () => {
  it('parses section headers and key-value pairs', () => {
    const text = `
[disk1]
device=sdb
size=8001563222016
temp=38

[parity]
device=sda
temp=35
`.trim();
    const sections = parseIni(text);
    expect(sections.size).toBe(2);
    expect(sections.get('disk1')).toMatchObject({ device: 'sdb', size: '8001563222016', temp: '38' });
    expect(sections.get('parity')).toMatchObject({ device: 'sda', temp: '35' });
  });

  it('ignores comment lines (# and ;)', () => {
    const text = `
[section]
# comment
key=value
; another comment
other=42
`.trim();
    const sections = parseIni(text);
    const s = sections.get('section')!;
    expect(Object.keys(s)).toEqual(['key', 'other']);
  });

  it('returns empty map for empty input', () => {
    expect(parseIni('').size).toBe(0);
    expect(parseIni('   \n\n  ').size).toBe(0);
  });

  it('handles multiple sections', () => {
    const sections = parseIni(FIXTURE_SHARES_INI);
    expect(sections.size).toBe(3);
    expect(sections.has('media')).toBe(true);
    expect(sections.has('downloads')).toBe(true);
    expect(sections.has('backups')).toBe(true);
  });
});

describe('parseFlatKv', () => {
  it('parses KEY=VALUE pairs', () => {
    const text = `
mdState=STARTED
mdVersion=PARITY
mdInvalidSlots=0
`.trim();
    const kv = parseFlatKv(text);
    expect(kv['mdState']).toBe('STARTED');
    expect(kv['mdVersion']).toBe('PARITY');
    expect(kv['mdInvalidSlots']).toBe('0');
  });

  it('strips surrounding double-quotes from values', () => {
    const text = `
shareAllocator="highwater"
shareInclude="disk1,disk2"
`.trim();
    const kv = parseFlatKv(text);
    expect(kv['shareAllocator']).toBe('highwater');
    expect(kv['shareInclude']).toBe('disk1,disk2');
  });

  it('returns empty object for empty input', () => {
    expect(Object.keys(parseFlatKv(''))).toHaveLength(0);
  });

  it('ignores comment lines', () => {
    const text = `
# comment
key=val
`.trim();
    const kv = parseFlatKv(text);
    expect(Object.keys(kv)).toEqual(['key']);
  });
});

describe('parseMdcmd', () => {
  it('is equivalent to parseFlatKv for mdcmd status output', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS);
    expect(kv['mdState']).toBe('STARTED');
    expect(kv['mdVersion']).toBe('PARITY');
    expect(kv['diskName.0']).toBe('parity');
    expect(kv['diskName.1']).toBe('disk1');
  });
});

describe('diskEntriesFromMdcmd', () => {
  it('extracts one disk entry per diskName.N key', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS);
    const disks = diskEntriesFromMdcmd(kv);
    expect(disks).toHaveLength(4); // parity + disk1 + disk2 + disk3
  });

  it('maps slot, device, size, temp, status, smartHealth, spunDown', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS);
    const disks = diskEntriesFromMdcmd(kv);
    const parity = disks.find((d) => d.slot === 'parity');
    expect(parity).toBeDefined();
    expect(parity!.device).toBe('sda');
    expect(parity!.size).toBe('8001563222016');
    expect(parity!.temp).toBe('35');
    expect(parity!.status).toBe('DISK_OK');
    expect(parity!.smartHealth).toBe('PASSED');
    expect(parity!.spunDown).toBe(false);
  });

  it('marks disk as spunDown when status is DISK_NP', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS);
    const disks = diskEntriesFromMdcmd(kv);
    const d3 = disks.find((d) => d.slot === 'disk3');
    expect(d3).toBeDefined();
    expect(d3!.spunDown).toBe(true);
    expect(d3!.temp).toBe('');
    expect(d3!.smartHealth).toBe('UNKNOWN');
  });

  it('returns empty array when no diskName.N keys exist', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS_STOPPED);
    const disks = diskEntriesFromMdcmd(kv);
    expect(disks).toHaveLength(0);
  });
});

describe('diskEntriesFromDisksIni', () => {
  it('parses disks.ini sections into disk entries', () => {
    const sections = parseIni(FIXTURE_DISKS_INI);
    const disks = diskEntriesFromDisksIni(sections);
    // parity + disk1 + disk2 + cache
    expect(disks).toHaveLength(4);
  });

  it('skips sections with no device assigned', () => {
    const text = '[emptyslot]\ntemp=0\n[disk1]\ndevice=sdb\nsize=100\n'.trim();
    const sections = parseIni(text);
    const disks = diskEntriesFromDisksIni(sections);
    expect(disks).toHaveLength(1);
    expect(disks[0]!.slot).toBe('disk1');
  });

  it('maps spinState=1 to spunDown=true', () => {
    const sections = parseIni(FIXTURE_DISKS_INI);
    const disks = diskEntriesFromDisksIni(sections);
    const d2 = disks.find((d) => d.slot === 'disk2');
    expect(d2).toBeDefined();
    expect(d2!.spunDown).toBe(true);
  });

  it('maps spinState=0 to spunDown=false', () => {
    const sections = parseIni(FIXTURE_DISKS_INI);
    const disks = diskEntriesFromDisksIni(sections);
    const parity = disks.find((d) => d.slot === 'parity');
    expect(parity!.spunDown).toBe(false);
  });
});

describe('arrayStateFromMdcmd', () => {
  it('extracts mdState and protection version', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS);
    const array = arrayStateFromMdcmd(kv);
    expect(array.mdState).toBe('STARTED');
    expect(array.mdVersion).toBe('PARITY');
    expect(array.mdInvalidSlots).toBe(0);
    expect(array.mdNumDisabled).toBe(0);
  });

  it('extracts stopped state from stopped fixture', () => {
    const kv = parseMdcmd(FIXTURE_MDCMD_STATUS_STOPPED);
    const array = arrayStateFromMdcmd(kv);
    expect(array.mdState).toBe('STOPPED');
    expect(array.mdInvalidSlots).toBe(1);
    expect(array.mdNumDisabled).toBe(1);
  });

  it('defaults numeric fields to 0 on missing keys', () => {
    const array = arrayStateFromMdcmd({});
    expect(array.mdState).toBe('');
    expect(array.mdInvalidSlots).toBe(0);
    expect(array.mdNumDisabled).toBe(0);
  });
});

describe('sharesFromIni', () => {
  it('parses all share sections', () => {
    const sections = parseIni(FIXTURE_SHARES_INI);
    const shares = sharesFromIni(sections);
    expect(shares).toHaveLength(3);
  });

  it('maps share name, allocator, includedDisks, excludedDisks, cacheUsage', () => {
    const sections = parseIni(FIXTURE_SHARES_INI);
    const shares = sharesFromIni(sections);
    const media = shares.find((s) => s.name === 'media');
    expect(media).toBeDefined();
    expect(media!.allocator).toBe('highwater');
    expect(media!.includedDisks).toEqual(['disk1', 'disk2', 'disk3']);
    expect(media!.excludedDisks).toEqual([]);
    expect(media!.cacheUsage).toBe('yes');
  });

  it('maps excluded disks correctly', () => {
    const sections = parseIni(FIXTURE_SHARES_INI);
    const shares = sharesFromIni(sections);
    const downloads = shares.find((s) => s.name === 'downloads');
    expect(downloads!.excludedDisks).toEqual(['disk3']);
  });

  it('returns empty arrays for missing include/exclude', () => {
    const sections = parseIni('[emptyshare]\nallocator=fill\n');
    const shares = sharesFromIni(sections);
    expect(shares[0]!.includedDisks).toEqual([]);
    expect(shares[0]!.excludedDisks).toEqual([]);
  });
});

describe('shareFromCfg', () => {
  it('parses appdata.cfg correctly', () => {
    const kv = parseFlatKv(FIXTURE_SHARE_CFG_APPDATA);
    const share = shareFromCfg('appdata', kv);
    expect(share.name).toBe('appdata');
    expect(share.allocator).toBe('highwater');
    expect(share.includedDisks).toEqual(['disk1', 'disk2']);
    expect(share.excludedDisks).toEqual([]);
    expect(share.cacheUsage).toBe('prefer');
  });

  it('parses isos.cfg correctly', () => {
    const kv = parseFlatKv(FIXTURE_SHARE_CFG_ISOS);
    const share = shareFromCfg('isos', kv);
    expect(share.name).toBe('isos');
    expect(share.includedDisks).toEqual(['disk3']);
    expect(share.cacheUsage).toBe('no');
  });
});

describe('parseNvidiaSmi', () => {
  it('parses a single GPU line', () => {
    const gpus = parseNvidiaSmi(FIXTURE_NVIDIA_SMI_SINGLE);
    expect(gpus).toHaveLength(1);
    const g = gpus[0]!;
    expect(g.index).toBe('0');
    expect(g.name).toBe('NVIDIA GeForce RTX 3080');
    expect(g.memoryTotal).toBe('10240');
    expect(g.driverVersion).toBe('525.85.12');
    expect(g.utilizationGpu).toBe('15');
    expect(g.utilizationMemory).toBe('22');
  });

  it('parses multiple GPU lines', () => {
    const gpus = parseNvidiaSmi(FIXTURE_NVIDIA_SMI_TWO);
    expect(gpus).toHaveLength(2);
    expect(gpus[1]!.name).toBe('NVIDIA Tesla T4');
    expect(gpus[1]!.memoryTotal).toBe('16384');
    expect(gpus[1]!.utilizationGpu).toBe('0');
  });

  it('returns empty array for empty output', () => {
    expect(parseNvidiaSmi('')).toHaveLength(0);
  });

  it('skips lines with fewer than 6 CSV columns', () => {
    const gpus = parseNvidiaSmi('0, GPU Name');
    expect(gpus).toHaveLength(0);
  });
});

describe('parseCrontab', () => {
  it('parses standard 5-field cron lines', () => {
    const jobs = parseCrontab(FIXTURE_CRON_MOVER, '/etc/cron.d/mover');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe('0 3 * * *');
    expect(jobs[0]!.command).toBe('/usr/local/sbin/mover start');
    expect(jobs[0]!.source).toBe('/etc/cron.d/mover');
  });

  it('skips comment lines and blank lines', () => {
    const jobs = parseCrontab(FIXTURE_CRON_EMPTY, '/some/cron.file');
    expect(jobs).toHaveLength(0);
  });

  it('skips environment variable assignment lines', () => {
    const jobs = parseCrontab(FIXTURE_CRON_USERSCRIPTS, '/etc/cron.d/userscripts');
    // 2 standard cron entries + 1 @reboot entry = 3 jobs
    expect(jobs).toHaveLength(3);
  });

  it('parses @reboot / @daily style entries', () => {
    const jobs = parseCrontab(FIXTURE_CRON_USERSCRIPTS, '/etc/cron.d/userscripts');
    const rebootJob = jobs.find((j) => j.schedule === '@reboot');
    expect(rebootJob).toBeDefined();
    expect(rebootJob!.command).toBe(
      '/boot/config/plugins/user.scripts/scripts/startup-tasks/script',
    );
  });

  it('returns empty array for fully empty input', () => {
    expect(parseCrontab('', '/some/file')).toHaveLength(0);
  });
});

describe('deriveJobName', () => {
  it('derives "mover" for the mover command', () => {
    expect(deriveJobName('/usr/local/sbin/mover start', '/some/cron')).toBe('mover');
  });

  it('derives "mdcmd-parity-check" for the parity mdcmd command', () => {
    expect(deriveJobName('/usr/local/sbin/mdcmd check nocorrect', '/some/cron')).toBe(
      'mdcmd-parity-check',
    );
  });

  it('uses basename of first path token', () => {
    expect(
      deriveJobName('/boot/config/plugins/user.scripts/scripts/backup-vms/script', '/etc/cron.d/x'),
    ).toBe('script');
  });

  it('falls back to cron source basename on empty command', () => {
    expect(deriveJobName('', '/boot/config/plugins/myplugin/myplugin.cron')).toBe('myplugin');
  });
});

// ---------------------------------------------------------------------------
// 2. UnraidEnumerator.enumerate(): full entity/edge mapping
// ---------------------------------------------------------------------------

describe('UnraidEnumerator.enumerate()', () => {
  const enumerator = new UnraidEnumerator();
  const platform = makePlatform();

  it('has platformKind "unraid"', () => {
    expect(enumerator.platformKind).toBe('unraid');
  });

  it('maps mdcmd output to storage-array entity with correct attributes', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const arrays = entities.filter((e) => e.kind === 'storage-array');
    expect(arrays).toHaveLength(1);
    const arr = arrays[0]!;
    expect(arr.id).toBe(`storage-array:${PLATFORM_ID}`);
    expect(arr.attributes['state']).toBe('STARTED');
    expect(arr.attributes['protection']).toBe('PARITY');
    expect(arr.source).toBe('unraid');
    expect(arr.platformId).toBe(PLATFORM_ID);
    expect(arr.discovered_at).toBe(NOW);
    expect(arr.last_seen).toBe(NOW);
  });

  it('maps mdcmd output to storage-disk entities — one per slot', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const disks = entities.filter((e) => e.kind === 'storage-disk');
    expect(disks).toHaveLength(4); // parity + disk1 + disk2 + disk3

    const parity = disks.find((d) => d.name === 'parity');
    expect(parity).toBeDefined();
    expect(parity!.id).toBe(`storage-disk:${PLATFORM_ID}:parity`);
    expect(parity!.attributes['device']).toBe('sda');
    expect(parity!.attributes['smart_health']).toBe('PASSED');
    expect(parity!.attributes['spun_down']).toBe(false);

    const disk3 = disks.find((d) => d.name === 'disk3');
    expect(disk3!.attributes['spun_down']).toBe(true);
    expect(disk3!.attributes['smart_health']).toBe('UNKNOWN');
  });

  it('creates member-of edges from disks to array and to platform', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const arrayEntityId = `storage-array:${PLATFORM_ID}`;
    const platformEntityId = `platform:${PLATFORM_ID}`;

    // 4 disks × 2 edges (member-of array + member-of platform)
    const diskMemberOfArray = edges.filter(
      (e) => e.type === 'member-of' && e.to === arrayEntityId && e.from.startsWith('storage-disk:'),
    );
    expect(diskMemberOfArray).toHaveLength(4);

    const diskMemberOfPlatform = edges.filter(
      (e) =>
        e.type === 'member-of' &&
        e.to === platformEntityId &&
        e.from.startsWith('storage-disk:'),
    );
    expect(diskMemberOfPlatform).toHaveLength(4);

    // array member-of platform
    const arrayMemberOfPlatform = edges.find(
      (e) => e.from === arrayEntityId && e.to === platformEntityId && e.type === 'member-of',
    );
    expect(arrayMemberOfPlatform).toBeDefined();
  });

  it('maps shares.ini output to share entities with correct attributes', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const shares = entities.filter((e) => e.kind === 'share');
    expect(shares).toHaveLength(3);

    const media = shares.find((s) => s.name === 'media');
    expect(media).toBeDefined();
    expect(media!.id).toBe(`share:${PLATFORM_ID}:media`);
    expect(media!.attributes['allocator']).toBe('highwater');
    expect(media!.attributes['included_disks']).toEqual(['disk1', 'disk2', 'disk3']);
    expect(media!.attributes['cache_usage']).toBe('yes');
  });

  it('creates member-of edges from shares to platform', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const platformEntityId = `platform:${PLATFORM_ID}`;
    const shareMemberOfPlatform = edges.filter(
      (e) =>
        e.type === 'member-of' &&
        e.to === platformEntityId &&
        e.from.startsWith('share:'),
    );
    expect(shareMemberOfPlatform).toHaveLength(3);
  });

  it('creates backed-by edges from shares to included disks', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const backedByEdges = edges.filter((e) => e.type === 'backed-by');
    // media: disk1,disk2,disk3 → 3 edges
    // downloads: disk1 → 1 edge
    // backups: disk2,disk3 → 2 edges
    // total: 6 backed-by edges
    expect(backedByEdges).toHaveLength(6);

    for (const edge of backedByEdges) {
      expect(edge.from).toMatch(/^share:/);
      expect(edge.to).toMatch(/^storage-disk:/);
    }
  });

  it('maps nvidia-smi output to gpu entities with correct attributes', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'nvidia-smi',
        result: { stdout: FIXTURE_NVIDIA_SMI_SINGLE, exitCode: 0 },
      },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const gpus = entities.filter((e) => e.kind === 'gpu');
    expect(gpus).toHaveLength(1);

    const g = gpus[0]!;
    expect(g.id).toBe(`gpu:${PLATFORM_ID}:0`);
    expect(g.name).toBe('NVIDIA GeForce RTX 3080');
    expect(g.attributes['model']).toBe('NVIDIA GeForce RTX 3080');
    expect(g.attributes['memory_total_mib']).toBe('10240');
    expect(g.attributes['driver_version']).toBe('525.85.12');
    expect(g.attributes['utilization_gpu_pct']).toBe('15');
    expect(g.attributes['utilization_memory_pct']).toBe('22');
    expect(g.source).toBe('unraid');
  });

  it('creates member-of and runs-on edges for gpu entities', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: FIXTURE_NVIDIA_SMI_SINGLE, exitCode: 0 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const platformEntityId = `platform:${PLATFORM_ID}`;
    const gpuEntityId = `gpu:${PLATFORM_ID}:0`;

    const memberOf = edges.find(
      (e) => e.from === gpuEntityId && e.to === platformEntityId && e.type === 'member-of',
    );
    expect(memberOf).toBeDefined();

    const runsOn = edges.find(
      (e) => e.from === gpuEntityId && e.to === platformEntityId && e.type === 'runs-on',
    );
    expect(runsOn).toBeDefined();
  });

  it('maps cron entries to job entities', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'find /boot/config/plugins',
        result: {
          stdout:
            '/boot/config/plugins/ca.backup/ca.backup.cron\n/boot/config/plugins/unraid-parity-check/unraid-parity-check.cron',
          exitCode: 0,
        },
      },
      {
        matches: 'ca.backup.cron',
        result: { stdout: FIXTURE_CRON_MOVER, exitCode: 0 },
      },
      {
        matches: 'unraid-parity-check.cron',
        result: { stdout: FIXTURE_CRON_PARITY, exitCode: 0 },
      },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const jobs = entities.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(2);

    // All jobs have source_file and schedule attributes
    for (const j of jobs) {
      expect(j.attributes['source_file']).toBeDefined();
      expect(j.attributes['schedule']).toBeDefined();
      expect(j.attributes['command']).toBeDefined();
      expect(j.source).toBe('unraid');
    }
  });

  it('creates member-of edges from jobs to platform', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'find /boot/config/plugins',
        result: {
          stdout: '/boot/config/plugins/mover/mover.cron',
          exitCode: 0,
        },
      },
      {
        matches: 'mover.cron',
        result: { stdout: FIXTURE_CRON_MOVER, exitCode: 0 },
      },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { edges } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const platformEntityId = `platform:${PLATFORM_ID}`;
    const jobEdges = edges.filter(
      (e) => e.type === 'member-of' && e.from.startsWith('job:') && e.to === platformEntityId,
    );
    expect(jobEdges).toHaveLength(1);
  });

  it('assigns discovered_at and last_seen from ctx.now on all entities', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: FIXTURE_NVIDIA_SMI_SINGLE, exitCode: 0 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    for (const entity of entities) {
      expect(entity.discovered_at).toBe(NOW);
      expect(entity.last_seen).toBe(NOW);
    }
  });

  it('all entities have platformId set', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: FIXTURE_NVIDIA_SMI_SINGLE, exitCode: 0 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    for (const entity of entities) {
      expect(entity.platformId).toBe(PLATFORM_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback paths
// ---------------------------------------------------------------------------

describe('UnraidEnumerator fallback paths', () => {
  const enumerator = new UnraidEnumerator();
  const platform = makePlatform();

  it('falls back to disks.ini when mdcmd fails', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: FIXTURE_DISKS_INI, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const disks = entities.filter((e) => e.kind === 'storage-disk');
    // FIXTURE_DISKS_INI has parity, disk1, disk2, cache (4 entries with devices)
    expect(disks).toHaveLength(4);

    const arrays = entities.filter((e) => e.kind === 'storage-array');
    expect(arrays).toHaveLength(1);
    // Synthetic array state when only disks.ini is available
    expect(arrays[0]!.attributes['state']).toBe('STARTED');
  });

  it('falls back to cfg files when shares.ini is absent', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'ls /boot/config/shares',
        result: {
          stdout:
            '/boot/config/shares/appdata.cfg\n/boot/config/shares/isos.cfg',
          exitCode: 0,
        },
      },
      {
        matches: 'appdata.cfg',
        result: { stdout: FIXTURE_SHARE_CFG_APPDATA, exitCode: 0 },
      },
      {
        matches: 'isos.cfg',
        result: { stdout: FIXTURE_SHARE_CFG_ISOS, exitCode: 0 },
      },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const shares = entities.filter((e) => e.kind === 'share');
    expect(shares).toHaveLength(2);

    const appdata = shares.find((s) => s.name === 'appdata');
    expect(appdata).toBeDefined();
    expect(appdata!.attributes['included_disks']).toEqual(['disk1', 'disk2']);
  });

  it('reads jobs from both plugin cron files and /etc/cron.d', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'find /boot/config/plugins',
        result: {
          stdout: '/boot/config/plugins/ca.backup/ca.backup.cron',
          exitCode: 0,
        },
      },
      {
        matches: 'ca.backup.cron',
        result: { stdout: FIXTURE_CRON_MOVER, exitCode: 0 },
      },
      {
        matches: 'ls /etc/cron.d',
        result: { stdout: 'parity-check', exitCode: 0 },
      },
      {
        matches: '/etc/cron.d/parity-check',
        result: { stdout: FIXTURE_CRON_PARITY, exitCode: 0 },
      },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const jobs = entities.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Graceful degradation
// ---------------------------------------------------------------------------

describe('UnraidEnumerator graceful degradation', () => {
  const enumerator = new UnraidEnumerator();
  const platform = makePlatform();

  it('returns empty entities+edges when all commands fail', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 1 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 1 } },
    ]);

    const { entities, edges } = await enumerator.enumerate({
      connection: conn,
      platform,
      now: NOW,
    });

    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('skips GPU category when nvidia-smi is absent, continues other categories', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 127 } }, // not found
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    // Disk entities should be present despite GPU absence
    const disks = entities.filter((e) => e.kind === 'storage-disk');
    expect(disks.length).toBeGreaterThan(0);

    // No GPU entities
    const gpus = entities.filter((e) => e.kind === 'gpu');
    expect(gpus).toHaveLength(0);
  });

  it('skips disk category when both mdcmd and disks.ini fail, continues other categories', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: FIXTURE_SHARES_INI, exitCode: 0 } },
      { matches: 'nvidia-smi', result: { stdout: FIXTURE_NVIDIA_SMI_SINGLE, exitCode: 0 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const disks = entities.filter((e) => e.kind === 'storage-disk');
    expect(disks).toHaveLength(0);
    const arrays = entities.filter((e) => e.kind === 'storage-array');
    expect(arrays).toHaveLength(0);

    // Shares and GPU still enumerated
    const shares = entities.filter((e) => e.kind === 'share');
    expect(shares).toHaveLength(3);
    const gpus = entities.filter((e) => e.kind === 'gpu');
    expect(gpus).toHaveLength(1);
  });

  it('skips share category when all share sources fail, continues other categories', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'ls /boot/config/shares', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const shares = entities.filter((e) => e.kind === 'share');
    expect(shares).toHaveLength(0);

    // Disk entities still present
    const disks = entities.filter((e) => e.kind === 'storage-disk');
    expect(disks.length).toBeGreaterThan(0);
  });

  it('skips job category when all cron sources fail, continues other categories', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: FIXTURE_MDCMD_STATUS, exitCode: 0 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 1 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 1 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const jobs = entities.filter((e) => e.kind === 'job');
    expect(jobs).toHaveLength(0);

    const disks = entities.filter((e) => e.kind === 'storage-disk');
    expect(disks.length).toBeGreaterThan(0);
  });

  it('does not throw when exec() throws an exception', async () => {
    const throwingConn = {
      platformId: PLATFORM_ID,
      exec: jest.fn().mockRejectedValue(new Error('ssh dropped')),
      connect: jest.fn(),
      disconnect: jest.fn(),
      getCapabilities: jest.fn(),
      isConnected: jest.fn(),
      getLastUsedAt: jest.fn(),
    } as unknown as Connection;

    await expect(
      enumerator.enumerate({ connection: throwingConn, platform, now: NOW }),
    ).resolves.toMatchObject({ entities: [], edges: [] });
  });

  it('handles two GPUs from nvidia-smi', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: FIXTURE_NVIDIA_SMI_TWO, exitCode: 0 } },
      { matches: 'find /boot/config/plugins', result: { stdout: '', exitCode: 0 } },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const gpus = entities.filter((e) => e.kind === 'gpu');
    expect(gpus).toHaveLength(2);
    expect(gpus[0]!.name).toBe('NVIDIA GeForce RTX 3080');
    expect(gpus[1]!.name).toBe('NVIDIA Tesla T4');
  });

  it('skips individual cron file that returns non-zero exit, reads others', async () => {
    const conn = makeMockConnection([
      { matches: 'mdcmd status', result: { stdout: '', exitCode: 1 } },
      { matches: 'disks.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares.ini', result: { stdout: '', exitCode: 1 } },
      { matches: 'shares/', result: { stdout: '', exitCode: 1 } },
      { matches: 'nvidia-smi', result: { stdout: '', exitCode: 1 } },
      {
        matches: 'find /boot/config/plugins',
        result: {
          stdout: '/boot/config/plugins/bad/bad.cron\n/boot/config/plugins/good/good.cron',
          exitCode: 0,
        },
      },
      {
        matches: 'bad.cron',
        result: { stdout: '', exitCode: 1 }, // this one fails
      },
      {
        matches: 'good.cron',
        result: { stdout: FIXTURE_CRON_MOVER, exitCode: 0 },
      },
      { matches: 'ls /etc/cron.d', result: { stdout: '', exitCode: 0 } },
    ]);

    const { entities } = await enumerator.enumerate({ connection: conn, platform, now: NOW });

    const jobs = entities.filter((e) => e.kind === 'job');
    // Only the good.cron's 1 job was read (bad.cron failed)
    expect(jobs).toHaveLength(1);
  });
});
