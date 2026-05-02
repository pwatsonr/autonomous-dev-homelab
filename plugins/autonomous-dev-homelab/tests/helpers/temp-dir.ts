/**
 * Per-test temp-directory helper. Implements SPEC-001-1-05 §"Determinism"
 * cleanup contract.
 *
 * Tests should pair `mkTempDir()` with `rmTempDir(dir)` in afterEach so
 * no state leaks between tests.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function mkTempDir(prefix = 'autonomous-dev-homelab-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rmTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
