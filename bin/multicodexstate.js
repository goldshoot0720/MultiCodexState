#!/usr/bin/env node
import chalk from 'chalk';

import { runCli, flushUpdateNotice } from '../src/cli.js';

runCli(process.argv.slice(2))
  .then(() => {
    // A background update check may have finished while the command ran;
    // give it a beat, then surface the nudge (if any) before exiting.
    setTimeout(() => {
      flushUpdateNotice();
    }, 60).unref();
  })
  .catch((err) => {
    console.error(chalk.red(`\n  ✖ ${err.message}\n`));
    process.exitCode = 1;
  });
