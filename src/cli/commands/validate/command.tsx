import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { handleValidate } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';
import React from 'react';

export const registerValidate = (program: Command) => {
  program
    .command('validate')
    .option('-d, --directory <path>', 'Project directory containing agentcore config')
    .description(COMMAND_DESCRIPTIONS.validate)
    .action(async options => {
      const result = await handleValidate(options);

      if (result.success) {
        const warnings = result.warnings ?? [];
        render(
          <Box flexDirection="column">
            {warnings.map((w, idx) => (
              <Text key={idx} color="yellow">
                Warning: {w}
              </Text>
            ))}
            <Text color="green">Valid</Text>
          </Box>
        );
        process.exit(0);
      } else {
        render(<Text color="red">{result.error}</Text>);
        process.exit(1);
      }
    });
};
