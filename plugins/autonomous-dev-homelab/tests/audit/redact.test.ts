/**
 * Unit tests for the audit-payload command redactor. SPEC-001-3-02 §Notes.
 * Verifies all documented patterns are masked.
 */

import { redactCommand } from '../../src/audit/redact';

describe('redactCommand', () => {
  it('masks `password=value`', () => {
    expect(redactCommand('connect password=hunter2 host')).toContain('[REDACTED]');
    expect(redactCommand('connect password=hunter2 host')).not.toContain('hunter2');
  });

  it('masks `--password value`', () => {
    const out = redactCommand('mysql --password supersecret -u root');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('supersecret');
  });

  it('masks `--password=value`', () => {
    const out = redactCommand('mysql --password=supersecret');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('supersecret');
  });

  it('masks `--token value` and `--token=value`', () => {
    expect(redactCommand('curl --token abcdef123456')).not.toContain('abcdef123456');
    expect(redactCommand('curl --token=abcdef123456')).not.toContain('abcdef123456');
  });

  it('masks Authorization: Bearer headers', () => {
    const out = redactCommand('curl -H "Authorization: Bearer eyJabc.def.ghi" https://x');
    expect(out).not.toContain('eyJabc.def.ghi');
    expect(out).toContain('[REDACTED]');
  });

  it('masks long base64-ish runs at word boundaries', () => {
    const out = redactCommand('echo aBcDeFgHiJ012345678901234ZZZ end');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('aBcDeFgHiJ012345678901234ZZZ');
  });

  it('does not mask short base64-like words', () => {
    expect(redactCommand('echo hello world')).toBe('echo hello world');
    expect(redactCommand('curl https://example.com/api')).toBe('curl https://example.com/api');
  });

  it('returns input unchanged when no patterns match', () => {
    expect(redactCommand('uptime')).toBe('uptime');
    expect(redactCommand('ls -la /var/log')).toBe('ls -la /var/log');
  });
});
