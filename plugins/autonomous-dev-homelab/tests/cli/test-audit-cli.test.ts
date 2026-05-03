/**
 * `audit` CLI subcommand tests. Covers SPEC-001-3-03 acceptance criteria
 * for `audit verify` and `audit query`.
 *
 * Strategy: build the command directly via `buildAuditCommand` against a
 * temp data-dir. Use a real `AuditWriter` to seed the log so the verify
 * path exercises the production HMAC chain.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { buildAuditCommand } from '../../src/cli/commands/audit';
import { AuditKeyStore } from '../../src/audit/key-store';
import { AuditWriter } from '../../src/audit/writer';
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

describe('audit CLI', () => {
  let tempDir: string;
  let logPath: string;
  let keyPath: string;
  let keyStore: AuditKeyStore;
  let writer: AuditWriter;

  beforeEach(async () => {
    tempDir = await mkTempDir('audit-cli-');
    logPath = path.join(tempDir, 'audit.log');
    keyPath = path.join(tempDir, '.audit-key');
    keyStore = new AuditKeyStore({ keyPath });
    let counter = 0;
    writer = new AuditWriter({
      logPath,
      keyStore,
      defaultActor: 'pwatson',
      now: (): Date => new Date(Date.UTC(2026, 3, 28 + counter++, 10, 0, 0, 0)),
    });
  });

  afterEach(async () => {
    await rmTempDir(tempDir);
  });

  // ---- audit verify -----------------------------------------------------

  describe('audit verify', () => {
    it('exits 0 on a clean log with chain intact (json)', async () => {
      await writer.append('discovery_started', { cidr: '192.168.1.0/24' });
      await writer.append('discovery_completed', { exit_code: 0 });

      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(['verify', '--json'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; entries_verified: number; first_seq: number; last_seq: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.entries_verified).toBe(2);
      expect(parsed.first_seq).toBe(1);
      expect(parsed.last_seq).toBe(2);
    });

    it('exits 0 on a clean log with chain intact (plain)', async () => {
      await writer.append('discovery_started', { cidr: '10.0.0.0/16' });

      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(['verify'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(0);
      expect(captured.stdout).toContain('1 entries verified, chain intact');
    });

    it('exits 0 with 0 entries when log is missing', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(['verify', '--json'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; entries_verified: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.entries_verified).toBe(0);
    });

    it('exits 1 on a tampered HMAC and identifies the failed seq', async () => {
      await writer.append('discovery_started', { cidr: '192.168.1.0/24' });
      await writer.append('discovery_completed', { exit_code: 0 });
      await writer.append('consent_granted', { cidr: '192.168.1.0/24' });

      // Tamper the second entry's payload (without recomputing hmac).
      const raw = await fs.readFile(logPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l !== '');
      const obj = JSON.parse(lines[1] ?? '{}') as { payload: { exit_code: number } };
      obj.payload.exit_code = 99;
      lines[1] = JSON.stringify(obj);
      await fs.writeFile(logPath, lines.join('\n') + '\n');

      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(['verify', '--json'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(1);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; failed_at_seq: number; reason: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.failed_at_seq).toBe(2);
      expect(parsed.reason).toBe('hmac_mismatch');
    });

    it('exits 1 on a seq gap', async () => {
      await writer.append('discovery_started', { cidr: '192.168.1.0/24' });
      await writer.append('discovery_completed', { exit_code: 0 });
      // Drop the middle line so seq jumps 1 -> ? (no gap actually,
      // but keep two and renumber the second).
      const raw = await fs.readFile(logPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l !== '');
      const obj = JSON.parse(lines[1] ?? '{}') as { seq: number };
      obj.seq = 5;
      lines[1] = JSON.stringify(obj);
      await fs.writeFile(logPath, lines.join('\n') + '\n');

      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(['verify', '--json'], { from: 'user' });

      expect(handle.lastExitCode()).toBe(1);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; failed_at_seq: number; reason: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.failed_at_seq).toBe(5);
      expect(parsed.reason).toBe('seq_gap');
    });
  });

  // ---- audit query ------------------------------------------------------

  describe('audit query', () => {
    beforeEach(async () => {
      await writer.append('discovery_started', { cidr: '192.168.1.0/24' });
      await writer.append('cert_signed', { serial: 1 }, { platform: 'proxmox-01' });
      await writer.append('cert_signed', { serial: 2 }, { platform: 'unraid-01' });
      await writer.append('cert_revoked', { fingerprint: 'SHA256:fakefp' }, { platform: 'unraid-01' });
      await writer.append(
        'command_executed',
        { exit_code: 0 },
        { platform: 'proxmox-01', actor: 'admin-user' },
      );
    });

    it('returns only matching platform + since (chronological)', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--platform', 'proxmox-01', '--since', '2026-04-28', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as Array<{ seq: number; platform: string }>;
      expect(parsed.every((e) => e.platform === 'proxmox-01')).toBe(true);
      // Should include both proxmox entries (cert_signed + command_executed).
      expect(parsed.length).toBe(2);
      expect(parsed[0]?.seq).toBeLessThan(parsed[1]?.seq ?? 0);
    });

    it('--limit caps results to N most-recent (json)', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--limit', '2', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as Array<{ seq: number }>;
      expect(parsed).toHaveLength(2);
      // Last two seqs should be 4 and 5.
      expect(parsed.map((e) => e.seq)).toEqual([4, 5]);
    });

    it('--event exact match returns matching entries only', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--event', 'cert_signed', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as Array<{ event: string }>;
      expect(parsed).toHaveLength(2);
      expect(parsed.every((e) => e.event === 'cert_signed')).toBe(true);
    });

    it('unknown --event returns empty array (no error)', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--event', 'connection_opened', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      expect(captured.stdout.trim()).toBe('[]');
    });

    it('--actor filter returns matching actor only', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--actor', 'admin-user', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const parsed = JSON.parse(captured.stdout) as Array<{ actor: string }>;
      expect(parsed.length).toBe(1);
      expect(parsed[0]?.actor).toBe('admin-user');
    });

    it('plain output prints one human-readable line per entry', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--platform', 'proxmox-01'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(0);
      const lines = captured.stdout.trim().split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('proxmox-01');
      expect(lines[0]).toContain('cert_signed');
    });

    it('rejects bad --since with a clear error', async () => {
      const { captured, streams } = captureStreams();
      const handle = buildAuditCommand({ logPath, keyStore, streams });
      await handle.command.parseAsync(
        ['query', '--since', 'tomorrow', '--json'],
        { from: 'user' },
      );

      expect(handle.lastExitCode()).toBe(1);
      const parsed = JSON.parse(captured.stdout) as { ok: boolean; code: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe('BAD_FILTER');
    });
  });
});
