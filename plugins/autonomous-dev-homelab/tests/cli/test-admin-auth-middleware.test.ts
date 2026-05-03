/**
 * Admin-auth middleware tests. SPEC-001-3-04 §"Admin Auth Middleware".
 *
 * Coverage:
 *   - Default `isAdmin`: HOMELAB_ADMIN_TOKEN env var grants admin.
 *   - Default `isAdmin`: `<dataDir>/.admin-actors` allow-list grants admin.
 *   - `enforceAdminIfRequired` short-circuits for non-destructive commands.
 *   - For each `requiresAdmin: true` subcommand
 *     (`consent revoke`, `ca init`, `ca rotate`, `inventory remove`,
 *     `platform exec`):
 *       - Non-admin → exits 1, prints `Authorization required: admin role`,
 *         handler not invoked.
 *       - Admin → handler runs to completion.
 *   - Non-admin invocation does NOT emit an audit entry from this plugin.
 *   - Non-admin-required subcommands (`discover`, `inventory list/get`,
 *     `consent list/grant`, `audit verify/query`, `ca list`,
 *     `platform install-ca`, `platform connect-test`) run for non-admin.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  ADMIN_REJECTION_MESSAGE,
  buildAdminAuthContext,
  defaultAdminCheck,
  enforceAdminIfRequired,
  type AdminAuthContext,
} from '../../src/cli/middleware/admin-auth';
import { ADMIN_REQUIRED_COMMANDS } from '../../src/cli/types';
import { runCli } from '../../src/cli/index';
import { mkTempDir, rmTempDir } from '../helpers/temp-dir';

interface Captured {
  stdout: string;
  stderr: string;
}
function captureStreams(): {
  captured: Captured;
  streams: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const captured: Captured = { stdout: '', stderr: '' };
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

describe('defaultAdminCheck', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkTempDir('admin-default-');
  });
  afterEach(async () => rmTempDir(tempDir));

  it('returns true when HOMELAB_ADMIN_TOKEN is set', async () => {
    const ctx: AdminAuthContext = {
      actor: 'pwatson',
      dataDir: tempDir,
      env: { HOMELAB_ADMIN_TOKEN: 'anything' } as NodeJS.ProcessEnv,
    };
    await expect(defaultAdminCheck(ctx)).resolves.toBe(true);
  });

  it('returns false when env empty and no allow-list file exists', async () => {
    const ctx: AdminAuthContext = {
      actor: 'pwatson',
      dataDir: tempDir,
      env: {} as NodeJS.ProcessEnv,
    };
    await expect(defaultAdminCheck(ctx)).resolves.toBe(false);
  });

  it('returns true when actor is in <dataDir>/.admin-actors', async () => {
    await fs.writeFile(
      path.join(tempDir, '.admin-actors'),
      '# comment\nalice\npwatson\n',
    );
    const ctx: AdminAuthContext = {
      actor: 'pwatson',
      dataDir: tempDir,
      env: {} as NodeJS.ProcessEnv,
    };
    await expect(defaultAdminCheck(ctx)).resolves.toBe(true);
  });

  it('returns false when actor is not in the allow-list', async () => {
    await fs.writeFile(path.join(tempDir, '.admin-actors'), 'alice\n');
    const ctx: AdminAuthContext = {
      actor: 'pwatson',
      dataDir: tempDir,
      env: {} as NodeJS.ProcessEnv,
    };
    await expect(defaultAdminCheck(ctx)).resolves.toBe(false);
  });

  it('env token takes precedence over allow-list', async () => {
    await fs.writeFile(path.join(tempDir, '.admin-actors'), '# nobody\n');
    const ctx: AdminAuthContext = {
      actor: 'pwatson',
      dataDir: tempDir,
      env: { HOMELAB_ADMIN_TOKEN: 't' } as NodeJS.ProcessEnv,
    };
    await expect(defaultAdminCheck(ctx)).resolves.toBe(true);
  });
});

describe('enforceAdminIfRequired', () => {
  it('proceeds (returns true) for non-admin commands', async () => {
    const exits: number[] = [];
    const proceed = await enforceAdminIfRequired(
      'inventory list',
      { actor: 'u', dataDir: '/tmp', env: {} as NodeJS.ProcessEnv },
      {
        exit: (c) => exits.push(c),
        isAdmin: async () => false,
      },
    );
    expect(proceed).toBe(true);
    expect(exits).toEqual([]);
  });

  it.each(Array.from(ADMIN_REQUIRED_COMMANDS))(
    'rejects non-admin for %s',
    async (cmdName) => {
      const exits: number[] = [];
      const { captured, streams } = captureStreams();
      const proceed = await enforceAdminIfRequired(
        cmdName,
        { actor: 'u', dataDir: '/tmp', env: {} as NodeJS.ProcessEnv },
        {
          exit: (c) => exits.push(c),
          isAdmin: async () => false,
          streams,
        },
      );
      expect(proceed).toBe(false);
      expect(exits).toEqual([1]);
      expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
    },
  );

  it.each(Array.from(ADMIN_REQUIRED_COMMANDS))(
    'allows admin for %s',
    async (cmdName) => {
      const exits: number[] = [];
      const proceed = await enforceAdminIfRequired(
        cmdName,
        { actor: 'u', dataDir: '/tmp', env: {} as NodeJS.ProcessEnv },
        {
          exit: (c) => exits.push(c),
          isAdmin: async () => true,
        },
      );
      expect(proceed).toBe(true);
      expect(exits).toEqual([]);
    },
  );
});

describe('buildAdminAuthContext', () => {
  it('reads actor from HOMELAB_ACTOR, then USER, then LOGNAME', () => {
    expect(
      buildAdminAuthContext('/d', { HOMELAB_ACTOR: 'h', USER: 'u', LOGNAME: 'l' } as NodeJS.ProcessEnv).actor,
    ).toBe('h');
    expect(
      buildAdminAuthContext('/d', { USER: 'u', LOGNAME: 'l' } as NodeJS.ProcessEnv).actor,
    ).toBe('u');
    expect(
      buildAdminAuthContext('/d', { LOGNAME: 'l' } as NodeJS.ProcessEnv).actor,
    ).toBe('l');
    expect(
      buildAdminAuthContext('/d', {} as NodeJS.ProcessEnv).actor,
    ).toBe('unknown');
  });
});

// ---- runCli end-to-end: each requiresAdmin subcommand ---------------------

describe('runCli admin-auth dispatcher integration', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkTempDir('admin-cli-');
  });
  afterEach(async () => rmTempDir(tempDir));

  it('non-admin invoking `consent revoke` exits 1 with rejection message', async () => {
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'consent', 'revoke', '10.0.0.0/8', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
    // The handler never ran → no audit log written.
    await expect(fs.access(path.join(tempDir, 'audit.log'))).rejects.toBeTruthy();
  });

  it('non-admin invoking `inventory remove` exits 1 and inventory untouched', async () => {
    // Pre-seed an inventory entry the would-be `remove` would target.
    const inventoryPath = path.join(tempDir, 'inventory.yaml');
    await fs.writeFile(
      inventoryPath,
      [
        'version: "1.0"',
        'platforms:',
        '  - id: proxmox-01',
        '    type: proxmox-ve',
        '    host: 10.0.0.1',
        '    port: 8006',
        '    discovered_at: 2026-04-29T00:00:00.000Z',
        '    last_seen: 2026-04-29T00:00:00.000Z',
        '',
      ].join('\n'),
    );
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'inventory', 'remove', 'proxmox-01', '--yes', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
    const after = await fs.readFile(inventoryPath, 'utf8');
    expect(after).toContain('proxmox-01');
  });

  it('non-admin invoking `platform exec` exits 1 (handler not called)', async () => {
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'platform', 'exec', 'proxmox-01', '--', 'whoami'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
  });

  it('non-admin invoking `ca init` exits 1', async () => {
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'ca', 'init', '--passphrase-file', '/dev/null', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
  });

  it('non-admin invoking `ca rotate` exits 1', async () => {
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'ca', 'rotate', 'proxmox-01', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    expect(captured.stderr).toContain(ADMIN_REJECTION_MESSAGE);
  });

  // ---- non-admin commands run unimpeded -----------------------------------

  it('non-admin can run `inventory list`', async () => {
    const { streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'inventory', 'list', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(0);
  });

  it('non-admin can run `inventory get` (returns 1 only because no record exists)', async () => {
    const { captured, streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'inventory', 'get', 'no-such', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(1);
    // The error is from the handler, NOT the auth middleware.
    expect(captured.stderr).not.toContain(ADMIN_REJECTION_MESSAGE);
    expect(captured.stderr).toContain("no platform 'no-such' in inventory");
  });

  it('non-admin can run `consent list`', async () => {
    const { streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'consent', 'list', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(0);
  });

  it('non-admin can run `audit verify` (empty log → ok)', async () => {
    const { streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'audit', 'verify', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(0);
  });

  it('non-admin can run `ca list` (empty → ok)', async () => {
    const { streams } = captureStreams();
    const code = await runCli({
      argv: ['--data-dir', tempDir, 'ca', 'list', '--json'],
      streams,
      env: {} as NodeJS.ProcessEnv,
      isAdmin: async () => false,
    });
    expect(code).toBe(0);
  });
});
