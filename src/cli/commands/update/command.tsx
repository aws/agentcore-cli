import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { handleUpdate } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerUpdate = (program: Command) => {
  const updateCmd = program.command('update').description(COMMAND_DESCRIPTIONS.update);

  // Default action for bare `agentcore update` - backwards compatibility with CLI self-update
  updateCmd.option('-c, --check', 'Check for updates without installing').action(async options => {
    try {
      render(<Text>Checking for updates...</Text>);
      const result = await handleUpdate(options.check ?? false);

      switch (result.status) {
        case 'up-to-date':
          render(<Text color="green">You are already on the latest version ({result.currentVersion})</Text>);
          break;
        case 'newer-local':
          render(
            <Text color="yellow">
              Your version ({result.currentVersion}) is newer than the published version ({result.latestVersion})
            </Text>
          );
          break;
        case 'update-available':
          render(
            <Text>
              Update available: {result.currentVersion} → <Text color="green">{result.latestVersion}</Text>
            </Text>
          );
          render(<Text>Run `agentcore update` to install the update.</Text>);
          break;
        case 'updated':
          render(<Text color="green">Successfully updated to {result.latestVersion}</Text>);
          break;
        case 'update-failed':
          render(<Text color="red">Failed to install update. Try running: npm install -g @aws/agentcore@latest</Text>);
          process.exit(1);
          break;
      }
    } catch (error) {
      render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
      process.exit(1);
    }
  });

  // CLI self-update subcommand
  updateCmd
    .command('cli')
    .description('Update the AgentCore CLI to the latest version')
    .option('-c, --check', 'Check for updates without installing')
    .action(async options => {
      try {
        render(<Text>Checking for updates...</Text>);
        const result = await handleUpdate(options.check ?? false);

        switch (result.status) {
          case 'up-to-date':
            render(<Text color="green">You are already on the latest version ({result.currentVersion})</Text>);
            break;
          case 'newer-local':
            render(
              <Text color="yellow">
                Your version ({result.currentVersion}) is newer than the published version ({result.latestVersion})
              </Text>
            );
            break;
          case 'update-available':
            render(
              <Text>
                Update available: {result.currentVersion} → <Text color="green">{result.latestVersion}</Text>
              </Text>
            );
            render(<Text>Run `agentcore update cli` to install the update.</Text>);
            break;
          case 'updated':
            render(<Text color="green">Successfully updated to {result.latestVersion}</Text>);
            break;
          case 'update-failed':
            render(
              <Text color="red">Failed to install update. Try running: npm install -g @aws/agentcore@latest</Text>
            );
            process.exit(1);
            break;
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
