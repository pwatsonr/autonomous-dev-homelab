/**
 * Sample Unraid command output fixtures for UnraidEnumerator tests.
 *
 * All names, device paths, and identifiers here are synthetic test values;
 * no real homelab node or share names are hard-coded in production code
 * (invariant #62). Fixtures are the only place that may reference concrete
 * names, and only for test assertion purposes.
 */

// ---------------------------------------------------------------------------
// mdcmd status fixture (array started, 3 data disks + 1 parity)
// ---------------------------------------------------------------------------

/**
 * Sample `mdcmd status` output representing a healthy 3-disk+parity array.
 * Slot indices: 0=parity, 1=disk1, 2=disk2, 3=disk3.
 */
export const FIXTURE_MDCMD_STATUS = `
mdState=STARTED
mdVersion=PARITY
mdInvalidSlots=0
mdNumDisabled=0
mdResyncAction=
mdResyncPos=0
diskName.0=parity
rdevName.0=sda
rdevSize.0=8001563222016
rdevTemp.0=35
rdevStatus.0=DISK_OK
rdevSmartStatus.0=PASSED
diskName.1=disk1
rdevName.1=sdb
rdevSize.1=8001563222016
rdevTemp.1=38
rdevStatus.1=DISK_OK
rdevSmartStatus.1=PASSED
diskName.2=disk2
rdevName.2=sdc
rdevSize.2=8001563222016
rdevTemp.2=40
rdevStatus.2=DISK_OK
rdevSmartStatus.2=FAILED
diskName.3=disk3
rdevName.3=sdd
rdevSize.3=12000138625024
rdevTemp.3=
rdevStatus.3=DISK_NP
rdevSmartStatus.3=UNKNOWN
`.trim();

/**
 * Sample `mdcmd status` output for an array that is STOPPED.
 */
export const FIXTURE_MDCMD_STATUS_STOPPED = `
mdState=STOPPED
mdVersion=NONE
mdInvalidSlots=1
mdNumDisabled=1
mdResyncAction=
mdResyncPos=0
`.trim();

// ---------------------------------------------------------------------------
// disks.ini fixture (fallback when mdcmd is unavailable)
// ---------------------------------------------------------------------------

/**
 * Sample `/var/local/emhttp/disks.ini` content (2 data disks + parity + cache).
 */
export const FIXTURE_DISKS_INI = `
[parity]
device=sda
size=8001563222016
temp=35
status=DISK_OK
smartStatus=PASSED
spinState=0

[disk1]
device=sdb
size=8001563222016
temp=38
status=DISK_OK
smartStatus=PASSED
spinState=0

[disk2]
device=sdc
size=8001563222016
temp=40
status=DISK_OK
smartStatus=FAILED
spinState=1

[cache]
device=nvme0n1
size=500107862016
temp=32
status=DISK_OK
smartStatus=PASSED
spinState=0
`.trim();

// ---------------------------------------------------------------------------
// shares.ini fixture
// ---------------------------------------------------------------------------

/**
 * Sample `/var/local/emhttp/shares.ini` content (3 shares).
 * share names, allocator, disk lists, and cache settings are synthetic.
 */
export const FIXTURE_SHARES_INI = `
[media]
shareAllocator=highwater
shareInclude=disk1,disk2,disk3
shareExclude=
shareCache=yes

[downloads]
shareAllocator=mostfree
shareInclude=disk1
shareExclude=disk3
shareCache=prefer

[backups]
shareAllocator=fill
shareInclude=disk2,disk3
shareExclude=
shareCache=no
`.trim();

// ---------------------------------------------------------------------------
// share .cfg fixtures
// ---------------------------------------------------------------------------

/**
 * Sample `/boot/config/shares/appdata.cfg` content.
 */
export const FIXTURE_SHARE_CFG_APPDATA = `
shareAllocator="highwater"
shareInclude="disk1,disk2"
shareExclude=""
shareCache="prefer"
`.trim();

/**
 * Sample `/boot/config/shares/isos.cfg` content.
 */
export const FIXTURE_SHARE_CFG_ISOS = `
shareAllocator="fill"
shareInclude="disk3"
shareExclude=""
shareCache="no"
`.trim();

// ---------------------------------------------------------------------------
// nvidia-smi fixture
// ---------------------------------------------------------------------------

/**
 * Sample `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output
 * for a single NVIDIA GPU.
 */
export const FIXTURE_NVIDIA_SMI_SINGLE = `
0, NVIDIA GeForce RTX 3080, 10240, 525.85.12, 15, 22
`.trim();

/**
 * Sample nvidia-smi output for two GPUs.
 */
export const FIXTURE_NVIDIA_SMI_TWO = `
0, NVIDIA GeForce RTX 3080, 10240, 525.85.12, 15, 22
1, NVIDIA Tesla T4, 16384, 525.85.12, 0, 0
`.trim();

// ---------------------------------------------------------------------------
// cron fixtures
// ---------------------------------------------------------------------------

/**
 * Sample plugin cron file content (mover + parity-check jobs).
 */
export const FIXTURE_CRON_MOVER = `
# Mover scheduled job
0 3 * * * /usr/local/sbin/mover start
`.trim();

/**
 * Sample plugin cron file content (parity-check job).
 */
export const FIXTURE_CRON_PARITY = `
# Parity check — first Sunday of month
30 2 * * 0 /usr/local/sbin/mdcmd check nocorrect
`.trim();

/**
 * Sample user-script plugin cron file with mixed entries.
 */
export const FIXTURE_CRON_USERSCRIPTS = `
# User Scripts plugin
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 4 * * * /boot/config/plugins/user.scripts/scripts/backup-vms/script
30 5 * * 1 /boot/config/plugins/user.scripts/scripts/update-containers/script
@reboot /boot/config/plugins/user.scripts/scripts/startup-tasks/script
`.trim();

/**
 * Cron file with only comments and blank lines (no valid jobs).
 */
export const FIXTURE_CRON_EMPTY = `
# This file is intentionally empty
# No jobs configured

`.trim();
