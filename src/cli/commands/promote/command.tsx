import { ConfigIO } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export const registerPromote = (program: Command) => {
  const promoteCmd = program.command('promote').description('Promote resources');

  promoteCmd
    .command('ab-test')
    .description('Promote the winning treatment of an A/B test (stops the test and updates agentcore.json)')
    .requiredOption('-i, --id <id>', 'A/B test ID')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) => {
      requireProject();

      return runCliCommand('promote.job', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const result = await engine.promote('ab-test', cliOptions.id);
        if (!result.success) {
          throw result.error;
        }
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, id: cliOptions.id }));
        } else {
          console.log(`\n✓ A/B test ${cliOptions.id} stopped and winning variant applied to agentcore.json.`);
          console.log(`\nRun: agentcore deploy\n`);
        }
        return { job_type: 'ab-test' };
      });
    });
};
