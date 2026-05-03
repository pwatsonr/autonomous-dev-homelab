/**
 * `inventory get` and `inventory remove` tests. SPEC-001-3-04
 * §"`inventory get`" and §"`inventory remove`".
 *
 * Coverage:
 *   - get: prints all fields (yaml-like) plain; raw record under --json;
 *          unknown id → EXIT_USAGE.
 *   - remove: revokes cert + drops record; --yes skips prompt; declining
 *             prompt aborts with no changes; revoke failure leaves
 *             inventory untouched (atomic abort); pubkey-cleanup hint in
 *             plain output.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  runInventoryGet,
  runInventoryRemove,
} from '../../src/cli/commands/inventory';
import { InventoryManager } from '../../src/discovery/inventory';
import { SSHCertificateManager } from '../../src/ca/manager';
import type { Platform } from '../../src/discovery/inventory-types';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface CapturedStreams {
  stdout: string;
  stderr: string;
}

function captureStreams(): {
  captured: CapturedStreams;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const captured: CapturedStreams = { stdout: '', stderr: '' };
  return {
    captured,
    streams: {
      stdout: (s) => {
        captured.stdout += s;
      },
      stderr: (s) => {
        captured.stderr += s;
      },
    },
  };
}

function platformEntry(id: string): Platform {
  return {
    id,
    type: 'proxmox-ve',
    host: '192.168.1.50',
    port: 8006,
    discovered_at: '2026-04-28T14:00:00.000Z',
    last_seen: '2026-04-29T09:00:00.000Z',
    connection: {
      ssh_user: 'claude-homelab',
      ssh_port: 22,
      mcp_endpoint: 'mcp-server-proxmox',
    } as Platform['connection'],
  };
}

// Minimal stub CAManager for "remove" tests that don't need real keygen.
function stubCA(opts: { revokeImpl?: (id: string) => Promise<unknown> } = {}): SSHCertificateManager {
  const ca = {
    revokeKeys: opts.revokeImpl ?? (async (id: string) => ({
      platformId: id,
      fingerprint: 'SHA256:fakefp',
      revokedAt: '2026-04-29T10:00:00.000Z',
    })),
  };
  return ca as unknown as SSHCertificateManager;
}

describe('inventory get', () => {
  let tempDir: string;
  let inventoryPath: string;
  beforeEach(async () => {
    tempDir = await mkTempDir('inventory-get-');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
  });
  afterEach(async () => rmTempDir(tempDir));

  it('prints YAML-like output for an existing platform (plain)', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    const { captured, streams } = captureStreams();
    const code = await runInventoryGet(
      { platformId: 'proxmox-01' },
      { inventoryManager: inv, streams },
    );
    expect(code).toBe(0);
    expect(captured.stdout).toMatch(/id: proxmox-01/);
    expect(captured.stdout).toMatch(/host: 192\.168\.1\.50/);
    expect(captured.stdout).toMatch(/type: proxmox-ve/);
    expect(captured.stdout).toMatch(/mcp_endpoint: mcp-server-proxmox/);
  });

  it('emits the raw record under --json', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    const { captured, streams } = captureStreams();
    const code = await runInventoryGet(
      { platformId: 'proxmox-01', json: true },
      { inventoryManager: inv, streams },
    );
    expect(code).toBe(0);
    const obj = JSON.parse(captured.stdout) as Platform;
    expect(obj.id).toBe('proxmox-01');
    expect(obj.connection?.mcp_endpoint).toBe('mcp-server-proxmox');
  });

  it('exits 1 for unknown platform-id', async () => {
    const inv = new InventoryManager(inventoryPath);
    const { captured, streams } = captureStreams();
    const code = await runInventoryGet(
      { platformId: 'nope' },
      { inventoryManager: inv, streams },
    );
    expect(code).toBe(1);
    expect(captured.stderr).toMatch(/no platform 'nope' in inventory/);
  });
});

describe('inventory remove', () => {
  let tempDir: string;
  let inventoryPath: string;
  beforeEach(async () => {
    tempDir = await mkTempDir('inventory-remove-');
    inventoryPath = path.join(tempDir, 'inventory.yaml');
  });
  afterEach(async () => rmTempDir(tempDir));

  it('--yes: revokes the cert and removes the record (plain output)', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    let revokeCalled = false;
    const ca = stubCA({
      revokeImpl: async (id: string) => {
        revokeCalled = true;
        expect(id).toBe('proxmox-01');
        return { platformId: id, fingerprint: 'SHA256:fp', revokedAt: 'now' };
      },
    });
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01', yes: true },
      { inventoryManager: inv, caManager: ca, streams },
    );
    expect(code).toBe(0);
    expect(revokeCalled).toBe(true);
    expect(captured.stdout).toMatch(/Removed proxmox-01; cert revoked/);
    expect(captured.stdout).toMatch(/CA pubkey on the platform is NOT removed/);
    expect(await inv.getPlatform('proxmox-01')).toBeNull();
  });

  it('--json --yes: emits {removed, cert_revoked} structured payload', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    const ca = stubCA();
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01', yes: true, json: true },
      { inventoryManager: inv, caManager: ca, streams },
    );
    expect(code).toBe(0);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.removed).toBe('proxmox-01');
    expect(obj.cert_revoked).toBe(true);
  });

  it('without --yes prompts; declining aborts with exit 0 and no changes', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    let revokeCalled = false;
    const ca = stubCA({
      revokeImpl: async () => {
        revokeCalled = true;
        return { platformId: 'x', fingerprint: 'x', revokedAt: 'x' };
      },
    });
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01' },
      {
        inventoryManager: inv,
        caManager: ca,
        streams,
        isTTY: () => true,
        confirm: async () => false,
      },
    );
    expect(code).toBe(0);
    expect(revokeCalled).toBe(false);
    expect(captured.stdout).toMatch(/Aborted/);
    expect(await inv.getPlatform('proxmox-01')).not.toBeNull();
  });

  it('non-TTY without --yes refuses with EXIT_USAGE', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    const ca = stubCA();
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01' },
      {
        inventoryManager: inv,
        caManager: ca,
        streams,
        isTTY: () => false,
      },
    );
    expect(code).toBe(1);
    expect(captured.stderr).toMatch(/--yes/);
    expect(await inv.getPlatform('proxmox-01')).not.toBeNull();
  });

  it('atomic abort: revoke failure leaves inventory unchanged', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    const ca = stubCA({
      revokeImpl: async () => {
        throw new Error('ssh-keygen exploded');
      },
    });
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01', yes: true, json: true },
      { inventoryManager: inv, caManager: ca, streams },
    );
    expect(code).toBe(1);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.ok).toBe(false);
    expect(obj.code).toBe('REVOKE_FAILED');
    // Inventory still has the entry.
    const still = await inv.getPlatform('proxmox-01');
    expect(still).not.toBeNull();
    expect(still?.id).toBe('proxmox-01');
  });

  it('NO_CERT cert-state: removes inventory and reports cert_revoked:false', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    // Use a real CA manager that has not signed any cert; revokeKeys
    // throws CAError(NO_CERT). The remove handler treats this as benign
    // and proceeds to phase 2 with cert_revoked=false.
    const realCA = new SSHCertificateManager({
      dataDir: tempDir,
      execFile: async () => ({ stdout: '', stderr: '' }),
    });
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'proxmox-01', yes: true, json: true },
      { inventoryManager: inv, caManager: realCA, streams },
    );
    expect(code).toBe(0);
    const obj = JSON.parse(captured.stdout) as Record<string, unknown>;
    expect(obj.cert_revoked).toBe(false);
    expect(await inv.getPlatform('proxmox-01')).toBeNull();
  });

  it('exits 1 for unknown platform-id', async () => {
    const inv = new InventoryManager(inventoryPath);
    const ca = stubCA();
    const { captured, streams } = captureStreams();
    const code = await runInventoryRemove(
      { platformId: 'nope', yes: true },
      { inventoryManager: inv, caManager: ca, streams },
    );
    expect(code).toBe(1);
    expect(captured.stderr).toMatch(/no platform 'nope' in inventory/);
  });

  // Sanity: confirm fs side-effects line up (defence against future regressions).
  it('inventory file no longer contains the removed entry on disk', async () => {
    const inv = new InventoryManager(inventoryPath);
    await inv.addPlatform(platformEntry('proxmox-01'));
    await inv.addPlatform({ ...platformEntry('proxmox-02'), id: 'proxmox-02' });
    const ca = stubCA();
    const { streams } = captureStreams();
    await runInventoryRemove(
      { platformId: 'proxmox-01', yes: true },
      { inventoryManager: inv, caManager: ca, streams },
    );
    const onDisk = await fs.readFile(inventoryPath, 'utf8');
    expect(onDisk).not.toContain('proxmox-01');
    expect(onDisk).toContain('proxmox-02');
  });
});
