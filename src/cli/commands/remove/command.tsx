import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { RemoveAllScreen, RemoveFlow } from '../../tui/screens/remove';
import { handleRemove, handleRemoveAll } from './actions';
import type { RemoveAllOptions, RemoveOptions, ResourceType } from './types';
import { validateRemoveAllOptions, validateRemoveOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

interface TUIRemoveOptions {
  force?: boolean;
  dryRun?: boolean;
}

function handleRemoveAllTUI(options: TUIRemoveOptions = {}): void {
  const { unmount } = render(
    <RemoveAllScreen
      isInteractive={false}
      force={options.force}
      dryRun={options.dryRun}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />
  );
}

function handleRemoveResourceTUI(resourceType: ResourceType, options: { force?: boolean }): void {
  const { clear, unmount } = render(
    <RemoveFlow
      isInteractive={false}
      force={options.force}
      initialResourceType={resourceType}
      onExit={() => {
        clear();
        unmount();
        process.exit(0);
      }}
    />
  );
}

async function handleRemoveCLI(options: RemoveOptions): Promise<void> {
  const validation = validateRemoveOptions(options);
  if (!validation.valid) {
    console.log(JSON.stringify({ success: false, error: validation.error }));
    process.exit(1);
  }

  const result = await handleRemove({
    resourceType: options.resourceType,
    name: options.name!,
    force: options.force,
  });

  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

async function handleRemoveAllCLI(options: RemoveAllOptions): Promise<void> {
  validateRemoveAllOptions(options);
  const result = await handleRemoveAll(options);
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

function registerResourceRemove(
  removeCommand: ReturnType<Command['command']>,
  subcommand: string,
  resourceType: ResourceType,
  description: string
) {
  removeCommand
    .command(subcommand)
    .description(description)
    .option('--name <name>', 'Name of resource to remove')
    .option('--force', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { name?: string; force?: boolean; json?: boolean }) => {
      try {
        requireProject();
        if (cliOptions.json) {
          await handleRemoveCLI({
            resourceType,
            name: cliOptions.name,
            force: cliOptions.force,
            json: true,
          });
        } else {
          handleRemoveResourceTUI(resourceType, { force: cliOptions.force });
        }
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

export const registerRemove = (program: Command) => {
  const removeCommand = program
    .command('remove')
    .description(COMMAND_DESCRIPTIONS.remove)
    .action(() => {
      removeCommand.help();
    });

  removeCommand
    .command('all')
    .description('Reset all agentcore schemas to empty state')
    .option('--force', 'Skip confirmation prompts')
    .option('--dry-run', 'Show what would be reset without actually resetting')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { force?: boolean; dryRun?: boolean; json?: boolean }) => {
      try {
        if (cliOptions.json) {
          await handleRemoveAllCLI({
            force: cliOptions.force,
            dryRun: cliOptions.dryRun,
            json: true,
          });
        } else {
          handleRemoveAllTUI({
            force: cliOptions.force,
            dryRun: cliOptions.dryRun,
          });
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });

  registerResourceRemove(removeCommand, 'agent', 'agent', 'Remove an agent from the project');
  registerResourceRemove(removeCommand, 'memory', 'memory', 'Remove a memory provider from the project');
  registerResourceRemove(removeCommand, 'identity', 'identity', 'Remove an identity provider from the project');
  registerResourceRemove(removeCommand, 'target', 'target', 'Remove a deployment target from the project');

  // MCP Tool disabled - replace with registerResourceRemove() call when enabling
  removeCommand
    .command('mcp-tool', { hidden: true })
    .description('Remove an MCP tool from the project')
    .option('--name <name>', 'Name of resource to remove')
    .option('--force', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('MCP Tool integration is coming soon.');
      process.exit(1);
    });

  // Gateway disabled - replace with registerResourceRemove() call when enabling
  removeCommand
    .command('gateway', { hidden: true })
    .description('Remove a gateway from the project')
    .option('--name <name>', 'Name of resource to remove')
    .option('--force', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(() => {
      console.error('AgentCore Gateway integration is coming soon.');
      process.exit(1);
    });
};
