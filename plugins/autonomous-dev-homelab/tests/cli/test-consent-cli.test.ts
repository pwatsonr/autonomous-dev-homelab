/**
 * `consent` CLI subcommand tests. Covers SPEC-001-3-03 acceptance criteria
 * for `consent list`, `consent grant`, `consent revoke`, plus audit
 * emission via the manager.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { buildConsentCommand } from '../../src/cli/commands/consent';
import { ConsentManager } from '../../src/consent/manager';
import { AuditKeyStore } from '../../src/audit/key-store';
import { AuditWriter } from '../../src/audit/writer';
import { OVERRIDE_ENV } from '../../src/consent/fingerprint';
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

describe('consent CLI', () => {
  let tempDir: string;
  let consentPath: string;
  let auditPath: string;
  let auditKeyPath: string;
  let originalFp: string | undefined;

  beforeEach(async () => {
    tempDir = await mkTempDir('consent-cli-');
    consentPath = path.join(tempDir, 'network_consent.yaml');
    auditPath = path.join(tempDir, 'audit.log');
    auditKeyPath = path.join(tempDir, '.audit-key');
    originalFp = process.env[OVERRIDE_ENV];
    process.env[OVERRIDE_ENV] = 'route=test;dns=test';
  });

  afterEach(async () => {
    if (originalFp === undefined) {
      delete process.env[OVERRIDE_ENV];
    } else {
      process.env[OVERRIDE_ENV] = originalFp;
    }
    await rmTempDir(tempDir);
  });

  function makeManager(approved: boolean, withAudit = true): {
    consentManager: ConsentManager;
    auditWriter?: AuditWriter;
  } {
    const auditWriter = withAudit
      ? new AuditWriter({
          logPath: auditPath,
          keyStore: new AuditKeyStore({ keyPath: auditKeyPath }),
          defaultActor: 'pwatson',
        })
      : undefined;
    const opts: ConstructorParameters<typeof ConsentManager>[1] = {
      promptFn: async () => approved,
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    };
    if (auditWriter !== undefined) opts.auditWriter = auditWriter;
    return {
      consentManager: new ConsentManager(consentPath, opts),
      auditWriter: auditWriter,
    };
  }

  // ---- list -------------------------------------------------------------

  it('list prints "No active consents." when empty (plain)', async () => {
    const { consentManager } = makeManager(false, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('No active consents.');
  });

  it('list emits [] in --json when empty', async () => {
    const { consentManager } = makeManager(false, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(['list', '--json'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout.trim()).toBe('[]');
  });

  it('list prints rows for active consents (table)', async () => {
    const { consentManager } = makeManager(true, false);
    await consentManager.requestConsent('192.168.1.0/24', [22, 8006], ['tcp_connect']);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(['list'], { from: 'user' });

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('CIDR');
    expect(captured.stdout).toContain('192.168.1.0/24');
    expect(captured.stdout).toContain('22,8006');
    expect(captured.stdout).toContain('tcp_connect');
  });

  // ---- grant ------------------------------------------------------------

  it('grant prints record on approval and persists', async () => {
    const { consentManager } = makeManager(true, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      [
        'grant',
        '192.168.1.0/24',
        '--ports',
        '22,8006',
        '--scan-types',
        'tcp_connect',
      ],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(0);
    expect(captured.stdout).toContain('Granted consent for 192.168.1.0/24');
    const list = await consentManager.listConsents();
    expect(list).toHaveLength(1);
    expect(list[0]?.cidr).toBe('192.168.1.0/24');
  });

  it('grant emits consent_granted audit entry', async () => {
    const { consentManager } = makeManager(true, true);
    const { streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['grant', '192.168.1.0/24', '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(0);
    const log = await fs.readFile(auditPath, 'utf8');
    const lines = log.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[0] ?? '{}') as { event: string; payload: { cidr: string } };
    expect(entry.event).toBe('consent_granted');
    expect(entry.payload.cidr).toBe('192.168.1.0/24');
  });

  it('grant on rejection exits 1 with structured error (json)', async () => {
    const { consentManager } = makeManager(false, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['grant', '192.168.1.0/24', '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('NOT_APPROVED');
  });

  it('grant rejects malformed --ports', async () => {
    const { consentManager } = makeManager(true, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['grant', '192.168.1.0/24', '--ports', '22,abc'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('invalid port');
  });

  it('grant rejects bad --ttl', async () => {
    const { consentManager } = makeManager(true, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['grant', '192.168.1.0/24', '--ttl', 'forever'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    expect(captured.stderr).toContain('invalid --ttl');
  });

  // ---- revoke -----------------------------------------------------------

  it('revoke removes the consent and emits consent_revoked audit entry', async () => {
    const { consentManager } = makeManager(true, true);
    await consentManager.requestConsent('192.168.1.0/24', [22], ['tcp_connect']);
    // Drop the audit log so we can verify only revoke's emission below.
    await fs.unlink(auditPath);

    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['revoke', '192.168.1.0/24', '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { revoked: string };
    expect(parsed.revoked).toBe('192.168.1.0/24');
    const log = await fs.readFile(auditPath, 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as { event: string };
    expect(entry.event).toBe('consent_revoked');
  });

  it('revoke on missing consent exits 1', async () => {
    const { consentManager } = makeManager(false, false);
    const { captured, streams } = captureStreams();
    const handle = buildConsentCommand({ consentManager, streams });
    await handle.command.parseAsync(
      ['revoke', '10.0.0.0/8', '--json'],
      { from: 'user' },
    );

    expect(handle.lastExitCode()).toBe(1);
    const parsed = JSON.parse(captured.stdout) as { code: string };
    expect(parsed.code).toBe('NOT_FOUND');
  });
});
