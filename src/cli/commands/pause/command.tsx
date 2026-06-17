import { ConfigIO, serializeResult } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { handlePauseResume } from '../../operations/eval';
import type { OnlineEvalActionOptions } from '../../operations/eval';
import { createJobEngine } from '../../operations/jobs';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function registerOnlineEvalSubcommand(parent: Command, action: 'pause' | 'resume') {
  const description =
    action === 'pause'
      ? 'Pause a deployed online eval config. Use --arn to target configs outside the project.'
      : 'Resume a paused online eval config. Use --arn to target configs outside the project.';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('online-eval')
    .description(description)
    .argument('[name]', 'Config name from project (not needed with --arn)')
    .option('--arn <arn>', 'Online eval config ARN — operate without a project directory')
    .option('--region <region>', 'AWS region override (auto-detected from ARN otherwise)')
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, cliOptions: { arn?: string; region?: string; json?: boolean }) => {
      if (!cliOptions.arn && !name) {
        const error = 'Either a config name or --arn is required';
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          render(<Text color="red">{error}</Text>);
        }
        process.exit(1);
      }

      if (!cliOptions.arn) {
        requireProject();
      }

      const options: OnlineEvalActionOptions = {
        name: name ?? '',
        arn: cliOptions.arn,
        region: cliOptions.region,
        json: cliOptions.json,
      };

      try {
        const result = await handlePauseResume(options, action);

        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult(result)));
        } else if (result.success) {
          const displayName = cliOptions.arn ? result.configId : name;
          console.log(`${pastTense} online eval config "${displayName}" (status: ${result.executionStatus})`);
        } else {
          render(<Text color="red">{result.error.message}</Text>);
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
    });
}

function registerABTestSubcommand(parent: Command, action: 'pause' | 'resume') {
  const verb = action === 'pause' ? 'Pause' : 'Resume';

  parent
    .command('ab-test')
    .description(`${verb} a running A/B test`)
    .requiredOption('-i, --id <id>', 'A/B test ID')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) => {
      requireProject();

      return runCliCommand(action === 'pause' ? 'pause.job' : 'resume.job', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const result =
          action === 'pause'
            ? await engine.pause('ab-test', cliOptions.id)
            : await engine.resume('ab-test', cliOptions.id);
        if (!result.success) {
          throw result.error;
        }
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, id: cliOptions.id }));
        } else {
          console.log(`\n✓ A/B test ${cliOptions.id} ${action === 'pause' ? 'paused' : 'resumed'}.\n`);
        }
        return { job_type: 'ab-test' };
      });
    });
}

function registerOnlineInsightsSubcommand(parent: Command, action: 'pause' | 'resume') {
  const description =
    action === 'pause'
      ? '[preview] Pause a deployed online insights config. Use --arn to target configs outside the project.'
      : '[preview] Resume a paused online insights config. Use --arn to target configs outside the project.';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('online-insights')
    .description(description)
    .argument('[name]', 'Config name from project (not needed with --arn)')
    .option('--arn <arn>', 'Online insights config ARN — operate without a project directory')
    .option('--region <region>', 'AWS region override (auto-detected from ARN otherwise)')
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, cliOptions: { arn?: string; region?: string; json?: boolean }) => {
      if (!cliOptions.arn && !name) {
        const error = 'Either a config name or --arn is required';
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          render(<Text color="red">{error}</Text>);
        }
        process.exit(1);
      }

      if (!cliOptions.arn) {
        requireProject();
      }

      const options: OnlineEvalActionOptions = {
        name: name ?? '',
        arn: cliOptions.arn,
        region: cliOptions.region,
        json: cliOptions.json,
      };

      try {
        const result = await handlePauseResume(options, action);

        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult(result)));
        } else if (result.success) {
          const displayName = cliOptions.arn ? result.configId : name;
          console.log(`${pastTense} online insights config "${displayName}" (status: ${result.executionStatus})`);
        } else {
          render(<Text color="red">{result.error.message}</Text>);
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
    });
}

export const registerPause = (program: Command) => {
  const pauseCmd = program.command('pause').description(COMMAND_DESCRIPTIONS.pause);
  registerOnlineEvalSubcommand(pauseCmd, 'pause');
  registerOnlineInsightsSubcommand(pauseCmd, 'pause');
  registerABTestSubcommand(pauseCmd, 'pause');
};

export const registerResume = (program: Command) => {
  const resumeCmd = program.command('resume').description(COMMAND_DESCRIPTIONS.resume);
  registerOnlineEvalSubcommand(resumeCmd, 'resume');
  registerOnlineInsightsSubcommand(resumeCmd, 'resume');
  registerABTestSubcommand(resumeCmd, 'resume');
};
