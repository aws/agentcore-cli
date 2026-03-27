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
    .description(
      'Run on-demand evaluation of runtime traces. Use --runtime-arn to evaluate runtimes outside the project.'
    )
    .option('-r, --runtime <name>', 'Runtime name from project config')
    .option('--runtime-arn <arn>', 'Runtime ARN — run outside a project directory')
    .option('-e, --evaluator <names...>', 'Evaluator name(s) from project or Builtin.* IDs')
    .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) — use with --runtime-arn for standalone mode')
    .option('--region <region>', 'AWS region (required with --runtime-arn, auto-detected otherwise)')
    .option('-s, --session-id <id>', 'Evaluate a specific session only')
    .option('-t, --trace-id <id>', 'Evaluate a specific trace only')
    .option(
      '--endpoint <name>',
      'Runtime endpoint name (e.g. PROMPT_V1). Defaults to AGENTCORE_RUNTIME_ENDPOINT env var, then DEFAULT'
    )
    .option('--days <days>', 'Lookback window in days', '7')
    .option('--output <path>', 'Custom output file path for results')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        runtime?: string;
        runtimeArn?: string;
        evaluator?: string[];
        evaluatorArn?: string[];
        region?: string;
        sessionId?: string;
        traceId?: string;
        endpoint?: string;
        days: string;
        output?: string;
        json?: boolean;
      }) => {
        const isArnMode = !!(cliOptions.runtimeArn && cliOptions.evaluatorArn);
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
          agent: cliOptions.runtime,
          agentArn: cliOptions.runtimeArn,
          evaluator: cliOptions.evaluator ?? [],
          evaluatorArn: cliOptions.evaluatorArn,
          region: cliOptions.region,
          sessionId: cliOptions.sessionId,
          traceId: cliOptions.traceId,
          endpoint: cliOptions.endpoint,
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
