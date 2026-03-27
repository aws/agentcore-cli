import { getErrorMessage } from '../../errors';
import { handleListEvalRuns } from '../../operations/eval';
import { getResultsPath } from '../../operations/eval/storage';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerEval = (program: Command) => {
  const evalCmd = program.command('evals').description(COMMAND_DESCRIPTIONS.evals);

  evalCmd
    .command('history')
    .description('Show past on-demand eval run results saved locally')
    .option('-r, --runtime <name>', 'Filter results by runtime name')
    .option('-n, --limit <count>', 'Max number of runs to display')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { runtime?: string; limit?: string; json?: boolean }) => {
      requireProject();

      try {
        const result = handleListEvalRuns({
          agent: cliOptions.runtime,
          limit: cliOptions.limit ? parseInt(cliOptions.limit, 10) : undefined,
          json: cliOptions.json,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          process.exit(result.success ? 0 : 1);
          return;
        }

        if (!result.success) {
          render(<Text color="red">{result.error}</Text>);
          process.exit(1);
        }

        const runs = result.runs ?? [];
        if (runs.length === 0) {
          console.log('No eval runs found. Run `agentcore run eval` to create one.');
          return;
        }

        console.log(`\n${'Date'.padEnd(22)} ${'Agent'.padEnd(20)} ${'Evaluators'.padEnd(30)} Sessions`);
        console.log('─'.repeat(90));

        for (const run of runs) {
          const scores = run.results.map(r => `${r.evaluator}=${r.aggregateScore.toFixed(2)}`).join(', ');
          const date = new Date(run.timestamp).toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          console.log(`${date.padEnd(22)} ${run.agent.padEnd(20)} ${scores.padEnd(30)} ${run.sessionCount}`);
        }

        try {
          console.log(`\nResults saved in: ${getResultsPath()}`);
        } catch {
          // ignore — no project context
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
