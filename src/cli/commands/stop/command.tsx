import { stopBatchEvaluation } from '../../aws/agentcore-batch-evaluation';
import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { getRegion } from '../shared/region-utils';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerStop = (program: Command) => {
  const stopCmd = program.command('stop').description(COMMAND_DESCRIPTIONS.stop);

  stopCmd
    .command('batch-evaluation')
    .description('[preview] Stop a running batch evaluation')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to stop')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { id: string; region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);

        const result = await stopBatchEvaluation({
          region,
          batchEvaluationId: cliOptions.id,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`\nBatch evaluation stopped successfully`);
          console.log(`ID: ${result.batchEvaluationId}`);
          console.log(`Status: ${result.status}\n`);
        }

        process.exit(0);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });
};
