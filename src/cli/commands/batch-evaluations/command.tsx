import { ConfigIO, JobNotFoundError, serializeResult } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import { printBatchEvaluationDetail, printBatchEvaluationHistory } from '../../operations/jobs/batch-evaluation/format';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export const registerBatchEvaluations = (program: Command) => {
  const cmd = program.command('batch-evaluations').description(COMMAND_DESCRIPTIONS.batchEvaluations);

  cmd
    .command('history')
    .description('List batch evaluation jobs (running jobs are refreshed from the service)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { json?: boolean }) => {
      requireProject();
      return runCliCommand('job.history', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const records = await engine.list({ type: 'batch-evaluation' });
        if (cliOptions.json) {
          console.log(
            JSON.stringify({
              success: true,
              batchEvaluations: records,
            })
          );
        } else {
          printBatchEvaluationHistory(records);
        }
        return { job_type: 'batch-evaluation' };
      });
    });

  // Bare positional on the group: `agentcore batch-evaluations <id>` shows one job.
  // (No .description() here — that would override the group description shown in the command list.)
  cmd
    .argument('<id>', 'Batch evaluation job ID to view')
    .option('--json', 'Output as JSON')
    .action((id: string, cliOptions: { json?: boolean }) => {
      requireProject();
      return runCliCommand('job.get', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const record = await engine.get('batch-evaluation', id);
        if (!record) {
          // Throw only — runCliCommand owns error output (single JSON line in --json, stderr otherwise).
          throw new JobNotFoundError(`Batch evaluation "${id}" not found.`);
        }
        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult({ success: true, ...record })));
        } else {
          printBatchEvaluationDetail(record);
        }
        return { job_type: 'batch-evaluation' };
      });
    });
};
