import { ConfigIO, serializeResult, toError } from '../../../lib';
import { getErrorMessage } from '../../errors';
import { runCliCommand } from '../../telemetry/cli-command-run.js';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject, requireTTY } from '../../tui/guards';
import { RemoveAllScreen, RemoveFlow } from '../../tui/screens/remove';
import type { RemoveAllOptions, RemoveResult } from './types';
import { validateRemoveAllOptions } from './validate';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

async function handleRemoveAll(_options: RemoveAllOptions): Promise<RemoveResult> {
  try {
    const configIO = new ConfigIO();

    // Get current project name to preserve it
    let projectName = 'Project';
    try {
      const current = await configIO.readProjectSpec();
      projectName = current.name;
    } catch {
      // Use default if can't read
    }

    // Reset agentcore.json (keep project name, clear all resources including gateways)
    await configIO.writeProjectSpec({
      name: projectName,
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
      policyEngines: [],
      configBundles: [],
      abTests: [],
      httpGateways: [],
    });

    // Preserve aws-targets.json and deployed-state.json so that
    // a subsequent `agentcore deploy` can tear down existing stacks.

    return {
      success: true,
      message: 'All schemas reset to empty state',
      note: 'Your source code has not been modified. Run `agentcore deploy` to apply changes to AWS.',
    };
  } catch (err) {
    return { success: false, error: toError(err) };
  }
}

async function handleRemoveAllCLI(options: RemoveAllOptions): Promise<void> {
  validateRemoveAllOptions(options);
  await runCliCommand('remove.all', !!options.json, async () => {
    const result = await handleRemoveAll(options);
    if (!result.success) throw result.error;
    console.log(JSON.stringify(serializeResult(result)));
    return {};
  });
}

export const registerRemove = (program: Command): Command => {
  const removeCommand = program.command('remove').description(COMMAND_DESCRIPTIONS.remove);

  // 'remove all' is a special command, not a primitive
  removeCommand
    .command('all')
    .description('Reset all agentcore schemas to empty state')
    .option('-y, --yes', 'Skip confirmation prompts [non-interactive]')
    .option('--dry-run', 'Show what would be reset without actually resetting [non-interactive]')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async (cliOptions: { yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      try {
        // Any flag triggers non-interactive CLI mode
        if (cliOptions.yes || cliOptions.dryRun || cliOptions.json) {
          await handleRemoveAllCLI({
            force: cliOptions.yes,
            dryRun: cliOptions.dryRun,
            json: cliOptions.json,
          });
        } else {
          requireTTY();
          const { unmount } = render(
            <RemoveAllScreen
              isInteractive={false}
              onExit={() => {
                unmount();
                process.exit(0);
              }}
            />
          );
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

  // Resource subcommands (agent, memory, credential, gateway, mcp-tool) are registered
  // via primitive.registerCommands() in cli.ts

  // Catch-all for TUI fallback when no subcommand is specified.
  // Commander matches named subcommands first, so this is safe even though
  // primitive subcommands are registered after this point.
  removeCommand
    .argument('[subcommand]')
    .action((subcommand: string | undefined, _options, cmd) => {
      if (subcommand) {
        console.error(`error: '${subcommand}' is not a valid subcommand.`);
        cmd.outputHelp();
        process.exit(1);
      }

      requireProject();
      requireTTY();

      const { clear, unmount } = render(
        <RemoveFlow
          isInteractive={false}
          onExit={() => {
            clear();
            unmount();
          }}
        />
      );
    })
    .showHelpAfterError()
    .showSuggestionAfterError();

  return removeCommand;
};
