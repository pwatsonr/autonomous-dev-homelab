/**
 * SPEC-002-1-05 — fake `autonomous-dev` shim used by the K8s end-to-end
 * test. Records every invocation to a log file so the test can assert
 * that promotion happened (and didn't repeat after dedup).
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MockAutonomousDev {
  /** Directory containing the `autonomous-dev` shim. Add to PATH or pass directly. */
  binDir: string;
  /** File the shim appends one line per invocation to. */
  logFile: string;
}

/**
 * Creates a tmp dir containing a fake `autonomous-dev` shell shim that
 * appends `$*` (all positional args, space-joined) to a log file and
 * exits 0. Promoter failure-path tests live elsewhere — this shim is
 * deliberately a happy-path stub.
 */
export async function makeMockAutonomousDev(): Promise<MockAutonomousDev> {
  const dir = await mkdtemp(join(tmpdir(), 'mock-ad-'));
  const logFile = join(dir, 'invocations.log');
  const bin = join(dir, 'autonomous-dev');
  // POSIX shell: `printf` (more portable than `echo -E`) appends one
  // line per invocation. Quoting `$*` collapses positional args by
  // IFS — sufficient for substring assertions.
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`;
  await writeFile(bin, script, 'utf8');
  await chmod(bin, 0o755);
  return { binDir: dir, logFile };
}
