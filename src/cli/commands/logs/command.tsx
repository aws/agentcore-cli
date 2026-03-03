import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { handleLogs } from './action';
import type { LogsOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

export const registerLogs = (program: Command) => {
  program
    .command('logs')
    .alias('l')
    .description(COMMAND_DESCRIPTIONS.logs)
    .option('--agent <name>', 'Select specific agent')
    .option('--since <time>', 'Start time (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time (e.g. "now", ISO 8601)')
    .option('--level <level>', 'Filter by log level (error, warn, info, debug)')
    .option('-n, --lines <count>', 'Maximum number of log lines to return')
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
};
