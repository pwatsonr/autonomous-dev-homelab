/**
 * Per-test environment setup for SPEC-002-2-05 safety/migration suites.
 *
 * Each test that touches HMAC-signed state files MUST:
 *   1. Call `setupSafetyEnv()` in beforeEach to get a fresh tmp dir +
 *      hardcoded HMAC secret.
 *   2. Call `teardownSafetyEnv(env)` in afterEach to remove the dir and
 *      restore env vars.
 *
 * The hardcoded secret is 36 chars (above the 32-char minimum). It is
 * deliberately obvious so it never leaks into production.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const TEST_SECRET = 'test-secret-must-be-at-least-32-characters-long';

export interface SafetyEnv {
  tmpDir: string;
  prevDataDir: string | undefined;
  prevSecret: string | undefined;
}

export function setupSafetyEnv(prefix = 'homelab-safety-test-'): SafetyEnv {
  const tmpDir = mkdtempSync(path.join(tmpdir(), prefix));
  const env: SafetyEnv = {
    tmpDir,
    prevDataDir: process.env['HOMELAB_DATA_DIR'],
    prevSecret: process.env['HOMELAB_HMAC_SECRET'],
  };
  process.env['HOMELAB_DATA_DIR'] = tmpDir;
  process.env['HOMELAB_HMAC_SECRET'] = TEST_SECRET;
  return env;
}

export function teardownSafetyEnv(env: SafetyEnv): void {
  if (env.prevDataDir === undefined) delete process.env['HOMELAB_DATA_DIR'];
  else process.env['HOMELAB_DATA_DIR'] = env.prevDataDir;
  if (env.prevSecret === undefined) delete process.env['HOMELAB_HMAC_SECRET'];
  else process.env['HOMELAB_HMAC_SECRET'] = env.prevSecret;
  try {
    rmSync(env.tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
