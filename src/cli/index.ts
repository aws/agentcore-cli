#!/usr/bin/env node
import { main } from './cli.js';
import { getErrorMessage } from './errors.js';

// Global safety net — prevent raw stack traces from reaching the user
process.on('uncaughtException', err => {
  console.error(`Error: ${getErrorMessage(err)}`);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error(`Error: ${getErrorMessage(reason)}`);
  process.exit(1);
});

main(process.argv).catch(err => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
