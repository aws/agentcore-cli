import { ConfigIO } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export const registerStop = (program: Command) => {
  const stopCmd = program.command('stop').description(COMMAND_DESCRIPTIONS.stop);

  stopCmd
    .command('ab-test')
    .description('Stop a running A/B test permanently')
    .requiredOption('-i, --id <id>', 'A/B test ID to stop')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) => {
      requireProject();

      return runCliCommand('stop.job', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const result = await engine.stop('ab-test', cliOptions.id);
        if (!result.success) {
          throw result.error;
        }
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, id: cliOptions.id }));
        } else {
          console.log(`\n✓ A/B test ${cliOptions.id} stop requested.\n`);
        }
        return { job_type: 'ab-test' };
      });
    });

  stopCmd
    .command('batch-evaluation')
    .description('Stop a running batch evaluation')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to stop')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) => {
      requireProject();

      return runCliCommand('stop.job', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const result = await engine.stop('batch-evaluation', cliOptions.id);
        if (!result.success) {
          throw result.error;
        }
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, id: cliOptions.id }));
        } else {
          console.log(`\n✓ Batch evaluation ${cliOptions.id} stop requested.\n`);
        }
        return { job_type: 'batch-evaluation' };
      });
    });
};
