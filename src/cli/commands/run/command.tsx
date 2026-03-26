import { getErrorMessage } from '../../errors';
import { handleRunEval } from '../../operations/eval';
import type { RunEvalOptions } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function formatRunOutput(result: Awaited<ReturnType<typeof handleRunEval>>): void {
  if (!result.run) return;

  const { run } = result;
  const date = new Date(run.timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  console.log(`\nAgent: ${run.agent} | ${date} | Sessions: ${run.sessionCount} | Lookback: ${run.lookbackDays}d\n`);

  for (const r of run.results) {
    const score = r.aggregateScore.toFixed(2);
    const errors = r.sessionScores.filter(s => s.errorMessage).length;
    const errorSuffix = errors > 0 ? ` (${errors} errors)` : '';
    console.log(`  ${r.evaluator}: ${score}${errorSuffix}`);
  }

  if (result.filePath) {
    console.log(`\nResults saved to: ${result.filePath}`);
  }
}

export const registerRun = (program: Command) => {
  const runCmd = program.command('run').description(COMMAND_DESCRIPTIONS.run);

  runCmd
    .command('eval')
    .description('Run on-demand evaluation of agent traces. Use --agent-arn to evaluate agents outside the project.')
    .option('-a, --agent <name>', 'Agent name from project config')
    .option('--agent-arn <arn>', 'Agent runtime ARN — run outside a project directory')
    .option('-e, --evaluator <names...>', 'Evaluator name(s) from project or Builtin.* IDs')
    .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) — use with --agent-arn for standalone mode')
    .option('--region <region>', 'AWS region (required with --agent-arn, auto-detected otherwise)')
    .option('-s, --session-id <id>', 'Evaluate a specific session only')
    .option('-t, --trace-id <id>', 'Evaluate a specific trace only')
    .option('--days <days>', 'Lookback window in days', '7')
    .option('--output <path>', 'Custom output file path for results')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        agent?: string;
        agentArn?: string;
        evaluator?: string[];
        evaluatorArn?: string[];
        region?: string;
        sessionId?: string;
        traceId?: string;
        days: string;
        output?: string;
        json?: boolean;
      }) => {
        const isArnMode = !!(cliOptions.agentArn && cliOptions.evaluatorArn);
        if (!isArnMode) {
          requireProject();
        }

        if (!cliOptions.evaluator && !cliOptions.evaluatorArn) {
          const error = 'At least one --evaluator or --evaluator-arn is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const options: RunEvalOptions = {
          agent: cliOptions.agent,
          agentArn: cliOptions.agentArn,
          evaluator: cliOptions.evaluator ?? [],
          evaluatorArn: cliOptions.evaluatorArn,
          region: cliOptions.region,
          sessionId: cliOptions.sessionId,
          traceId: cliOptions.traceId,
          days: parseInt(cliOptions.days, 10),
          output: cliOptions.output,
          json: cliOptions.json,
        };

        try {
          const result = await handleRunEval(options);

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            formatRunOutput(result);
          } else {
            formatRunOutput(result);
            render(<Text color="red">{result.error}</Text>);
          }

          process.exit(result.success ? 0 : 1);
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          }
          process.exit(1);
        }
      }
    );
};
