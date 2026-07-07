import { ConfigIO, JobNotFoundError, serializeResult } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import { printRecommendationDetail, printRecommendationHistory } from '../../operations/jobs/recommendation/format';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export const registerRecommendations = (program: Command) => {
  const recCmd = program.command('recommendations').description(COMMAND_DESCRIPTIONS.recommendations);

  recCmd
    .command('history')
    .description('List recommendation jobs (running jobs are refreshed from the service)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { json?: boolean }) => {
      requireProject();
      return runCliCommand('job.history', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const records = await engine.list({ type: 'recommendation' });
        if (cliOptions.json) {
          console.log(
            JSON.stringify({
              success: true,
              recommendations: records,
            })
          );
        } else {
          printRecommendationHistory(records);
        }
        return { job_type: 'recommendation' };
      });
    });

  // Bare positional on the group: `agentcore recommendations <id>` shows one job.
  // (No .description() here — that would override the group description shown in the command list.)
  recCmd
    .argument('<id>', 'Recommendation job ID to view')
    .option('--json', 'Output as JSON')
    .action((id: string, cliOptions: { json?: boolean }) => {
      requireProject();
      return runCliCommand('job.get', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const record = await engine.get('recommendation', id);
        if (!record) {
          // Throw only — runCliCommand owns error output (single JSON line in --json, stderr otherwise).
          throw new JobNotFoundError(`Recommendation "${id}" not found.`);
        }
        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult({ success: true, ...record })));
        } else {
          printRecommendationDetail(record);
        }
        return { job_type: 'recommendation' };
      });
    });
};
