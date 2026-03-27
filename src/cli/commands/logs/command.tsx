import { getErrorMessage } from '../../errors';
import { handleLogsEval } from '../../operations/eval';
import type { LogsEvalOptions } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { handleLogs } from './action';
import type { LogsOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerLogs = (program: Command) => {
  // enablePositionalOptions + passThroughOptions ensure options like --since and --runtime
  // are passed to the 'evals' subcommand rather than being consumed by the parent 'logs' command.
  program.enablePositionalOptions();

  const logsCmd = program
    .command('logs')
    .alias('l')
    .enablePositionalOptions()
    .passThroughOptions()
    .description(COMMAND_DESCRIPTIONS.logs)
    .option('--runtime <name>', 'Select specific runtime')
    .option('--since <time>', 'Start time — defaults to 1h ago in search mode (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time — defaults to now in search mode (e.g. "now", ISO 8601)')
    .option('--level <level>', 'Filter by log level (error, warn, info, debug)')
    .option('-n, --limit <count>', 'Maximum number of log lines to return')
    .option('--query <text>', 'Server-side text filter')
    .option('--json', 'Output as JSON Lines')
    .action(async (cliOptions: LogsOptions) => {
      requireProject();

      try {
        const result = await handleLogs(cliOptions);

        if (!result.success) {
          render(<Text color="red">{result.error}</Text>);
          process.exit(1);
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });

  logsCmd
    .command('evals')
    .description('Stream or search online eval logs')
    .option('-r, --runtime <name>', 'Select specific runtime')
    .option('--since <time>', 'Start time (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time (e.g. "now", ISO 8601)')
    .option('-n, --limit <count>', 'Maximum number of log lines')
    .option('-f, --follow', 'Stream logs in real-time (default when no --since/--until)')
    .option('--json', 'Output as JSON Lines')
    .action(async (cliOptions: LogsEvalOptions) => {
      requireProject();

      try {
        const result = await handleLogsEval(cliOptions);

        if (!result.success) {
          render(<Text color="red">{result.error}</Text>);
          process.exit(1);
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
