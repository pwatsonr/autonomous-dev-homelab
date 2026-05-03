/**
 * SPEC-002-1-05 — per-probe coverage audit (meta-test).
 *
 * Verifies that every probe shipped under PLAN-002-1 maintains a
 * minimum coverage threshold (≥90% statements, ≥85% branches). This
 * is a guard against silent test rot: if a probe file exists but its
 * test was deleted (or the probe regressed below threshold), this
 * test fails loudly.
 *
 * Operates against `coverage/coverage-summary.json` produced by
 * `npx jest --coverage` (the project's `test:coverage` script).
 * When the coverage report is absent (e.g. tests were run without
 * `--coverage`), the suite SKIPS rather than fails — the audit only
 * runs in coverage-producing CI jobs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COVERAGE_SUMMARY_PATH = join(__dirname, '..', '..', '..', 'coverage', 'coverage-summary.json');

const PROBES = [
  'k8s',
  'docker',
  'proxmox',
  'unifi',
  'zfs',
  'smart',
  'cert-expiry',
  'backup-overdue',
  'daemon-heartbeat',
] as const;

interface CoveragePctBlock {
  pct: number;
}

interface CoverageEntry {
  statements: CoveragePctBlock;
  branches: CoveragePctBlock;
  functions: CoveragePctBlock;
  lines: CoveragePctBlock;
}

type CoverageSummary = Record<string, CoverageEntry>;

function loadSummary(): CoverageSummary | null {
  if (!existsSync(COVERAGE_SUMMARY_PATH)) return null;
  const raw = readFileSync(COVERAGE_SUMMARY_PATH, 'utf8');
  return JSON.parse(raw) as CoverageSummary;
}

const summary = loadSummary();
const haveCoverage = summary !== null;

(haveCoverage ? describe : describe.skip)(
  'probe coverage thresholds (≥90% statements, ≥85% branches)',
  () => {
    test.each(PROBES)('%s probe meets coverage thresholds', (probe) => {
      // Cast is safe inside the gated describe — the wrapper guarantees non-null.
      const s = summary as CoverageSummary;
      const key = Object.keys(s).find((k) => k.endsWith(`/probes/${probe}.ts`));
      if (key === undefined) {
        throw new Error(
          `no coverage entry for ${probe}.ts — did the file move, or is the probe test missing?`,
        );
      }
      const entry = s[key];
      if (entry === undefined) {
        throw new Error(`coverage entry for ${probe}.ts present in keys but missing in map`);
      }
      expect(entry.statements.pct).toBeGreaterThanOrEqual(90);
      expect(entry.branches.pct).toBeGreaterThanOrEqual(85);
    });
  },
);

// Sentinel test so the file always reports at least one passing case
// (jest treats files with zero invoked tests as a configuration error
// in `passWithNoTests=false` mode; the sibling probe tests use this
// pattern too).
describe('coverage audit guard', () => {
  test('coverage summary path is wired correctly', () => {
    // Either the summary is loaded OR the path is well-formed but the
    // file does not exist (non-coverage run). Both are valid states.
    expect(typeof COVERAGE_SUMMARY_PATH).toBe('string');
    expect(COVERAGE_SUMMARY_PATH).toMatch(/coverage-summary\.json$/);
  });
});
