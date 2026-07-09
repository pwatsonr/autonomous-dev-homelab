/**
 * CLI wiring test: verifies that `inventory topology` is registered in the
 * command tree (issue #29).
 *
 * Approach: runs the CLI with `inventory topology --help` and asserts that
 * commander recognises the command and emits its description without an
 * "unknown command" error. Also verifies that `runCli` can be imported
 * and that TopologyEnricher and runTopology are importable (static type
 * linkage check that catches misconfigured imports).
 *
 * We do NOT make live HTTP calls or live graph-store reads here.
 */

import { runCli } from '../../src/cli/index';
import { TopologyEnricher } from '../../src/discovery/topology/index';
import { runTopology } from '../../src/cli/commands/topology';

// ---------------------------------------------------------------------------
// Static import proof: the modules exist and export the expected symbols
// ---------------------------------------------------------------------------

describe('topology module exports', () => {
  it('TopologyEnricher is a constructor function', () => {
    expect(typeof TopologyEnricher).toBe('function');
  });

  it('runTopology is a function', () => {
    expect(typeof runTopology).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// CLI registration proof: `inventory topology --help` succeeds
// ---------------------------------------------------------------------------

describe('inventory topology CLI registration', () => {
  const makeStreams = () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    return {
      streams: {
        stdout: (s: string) => { outLines.push(s); },
        stderr: (s: string) => { errLines.push(s); },
      },
      outLines,
      errLines,
    };
  };

  it('recognises `inventory topology --help` without "unknown command" error', async () => {
    const { streams, outLines, errLines } = makeStreams();

    // Commander will throw a CommanderError for --help (helpDisplayed), which
    // runCli catches and returns EXIT_OK.
    const code = await runCli({
      argv: ['inventory', 'topology', '--help'],
      streams,
      env: {},
    });

    // Exit code must be 0 (help displayed → EXIT_OK).
    expect(code).toBe(0);

    // Combined output should mention the command.
    const all = [...outLines, ...errLines].join('');
    expect(all).toMatch(/topology/i);

    // Must NOT contain "unknown command".
    expect(all).not.toMatch(/unknown command/i);
  });

  it('inventory --help lists topology as a subcommand', async () => {
    const { streams, outLines, errLines } = makeStreams();

    const code = await runCli({
      argv: ['inventory', '--help'],
      streams,
      env: {},
    });

    expect(code).toBe(0);
    const all = [...outLines, ...errLines].join('');
    expect(all).toContain('topology');
  });
});
