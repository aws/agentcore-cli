import { getErrorMessage } from '../../errors';
import { listAllRecommendations } from '../../operations/recommendation';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerRecommendations = (program: Command) => {
  const recCmd = program.command('recommendations').description(COMMAND_DESCRIPTIONS.recommendations);

  recCmd
    .command('history')
    .description('Show past recommendation runs saved locally')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { json?: boolean }) => {
      requireProject();

      try {
        const records = listAllRecommendations();

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, recommendations: records }));
          process.exit(0);
          return;
        }

        if (records.length === 0) {
          console.log('No recommendation runs found. Run `agentcore run recommendation` to create one.');
          return;
        }

        console.log(
          `\n${'Date'.padEnd(22)} ${'Type'.padEnd(20)} ${'Agent'.padEnd(20)} ${'Recommendation ID'.padEnd(40)}`
        );
        console.log('─'.repeat(105));

        for (const record of records) {
          const date = record.startedAt
            ? new Date(record.startedAt).toLocaleString([], {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : 'unknown';
          console.log(
            `${date.padEnd(22)} ${(record.type ?? 'unknown').padEnd(20)} ${(record.agent ?? 'unknown').padEnd(20)} ${record.recommendationId.padEnd(40)}`
          );
        }

        console.log('');
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
