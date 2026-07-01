/**
 * Integration test: build pipeline.
 * SPEC: REQ-000055 TASK-015, T015-1.
 *
 * Gated by INTEGRATION=1 env var.
 * Tests that bash scripts/build.sh exits 0 and produces dist/cli/index.js.
 */

import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const PLUGIN_DIR = path.join(__dirname, '..', '..');
const INTEGRATION = process.env['INTEGRATION'] === '1';

describe('build pipeline integration', () => {
  (INTEGRATION ? it : it.skip)(
    'T015-1: bash scripts/build.sh exits 0 and produces dist/cli/index.js',
    async () => {
      const result = await runCommand('bash', ['scripts/build.sh'], PLUGIN_DIR);
      expect(result.exitCode).toBe(0);

      const cliPath = path.join(PLUGIN_DIR, 'dist', 'cli', 'index.js');
      await expect(fs.access(cliPath)).resolves.toBeUndefined();
    },
    180_000,
  );

  (INTEGRATION ? it : it.skip)(
    'T002-2: node dist/cli/index.js --help works after build',
    async () => {
      const result = await runCommand('node', ['dist/cli/index.js', '--help'], PLUGIN_DIR);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/homelab|autonomous-dev-homelab/i);
    },
    30_000,
  );

  (INTEGRATION ? it : it.skip)(
    'T002-3: no test files in dist/',
    async () => {
      const result = await runCommand('find', ['dist', '-path', '*/tests/*'], PLUGIN_DIR);
      expect(result.stdout.trim()).toBe('');
    },
    30_000,
  );
});

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
