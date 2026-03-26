import { getErrorMessage } from '../../errors';
import { handlePauseResume } from '../../operations/eval';
import type { OnlineEvalActionOptions } from '../../operations/eval';
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
          console.log(JSON.stringify(result));
        } else if (result.success) {
          const displayName = cliOptions.arn ? result.configId : name;
          console.log(`${pastTense} online eval config "${displayName}" (status: ${result.executionStatus})`);
        } else {
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
    });
}

export const registerPause = (program: Command) => {
  const pauseCmd = program.command('pause').description(COMMAND_DESCRIPTIONS.pause);
  registerOnlineEvalSubcommand(pauseCmd, 'pause');
};

export const registerResume = (program: Command) => {
  const resumeCmd = program.command('resume').description(COMMAND_DESCRIPTIONS.resume);
  registerOnlineEvalSubcommand(resumeCmd, 'resume');
};
