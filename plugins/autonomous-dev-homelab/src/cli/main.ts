#!/usr/bin/env node
/**
 * CLI executable entry point.
 * Invokes `runCli` with the process arguments and exits with the result code.
 */

import { runCli } from './index.js';

void runCli({ argv: process.argv.slice(2) }).then((code) => {
  process.exit(code);
});
