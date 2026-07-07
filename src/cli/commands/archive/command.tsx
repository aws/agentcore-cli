import { ConfigIO } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import type { JobType } from '../../operations/jobs';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

/** Archive a job: delete it from the service and remove the local .cli record via the engine. */
function executeArchive(
  jobType: JobType,
  cliOptions: { id: string; region?: string; json?: boolean },
  label: string
): Promise<never> {
  requireProject();
  return runCliCommand('archive.job', !!cliOptions.json, async () => {
    const engine = createJobEngine(new ConfigIO());
    const result = await engine.archive(jobType, cliOptions.id);
    if (!result.success) {
      throw result.error;
    }
    if (cliOptions.json) {
      console.log(JSON.stringify({ success: true, id: cliOptions.id }));
    } else {
      console.log(`\n✓ ${label} ${cliOptions.id} archived.\n`);
    }
    return { job_type: jobType };
  });
}

export const registerArchive = (program: Command) => {
  const archiveCmd = program.command('archive').description(COMMAND_DESCRIPTIONS.archive);

  archiveCmd
    .command('batch-evaluation')
    .description('Archive a batch evaluation job record on the service and clear local history')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive('batch-evaluation', cliOptions, 'Batch evaluation')
    );

  archiveCmd
    .command('recommendation')
    .description('Archive a recommendation job record on the service and clear local history')
    .requiredOption('-i, --id <id>', 'Recommendation ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive('recommendation', cliOptions, 'Recommendation')
    );

  archiveCmd
    .command('ab-test')
    .description('Archive (delete) an A/B test on the service and clear local history')
    .requiredOption('-i, --id <id>', 'A/B test ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive('ab-test', cliOptions, 'A/B test')
    );

  archiveCmd
    .command('insights')
    .description('[preview] Archive an insights job record on the service and clear local history')
    .requiredOption('-i, --id <id>', 'Insights job ID to archive')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) =>
      executeArchive('insights', cliOptions, 'Insights job')
    );
};
