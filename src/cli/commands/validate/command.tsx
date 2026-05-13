import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { handleValidate } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';

export const registerValidate = (program: Command) => {
  program
    .command('validate')
    .option('-d, --directory <path>', 'Project directory containing agentcore config')
    .description(COMMAND_DESCRIPTIONS.validate)
    .action(async options => {
      const result = await handleValidate(options);

      if (result.success) {
        render(<Text color="green">Valid</Text>);
        process.exit(0);
      } else {
        render(<Text color="red">{result.error.message}</Text>);
        process.exit(1);
      }
    });
};
