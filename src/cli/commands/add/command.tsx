import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { AddFlow } from '../../tui/screens/add/AddFlow';
import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

export function registerAdd(program: Command): Command {
  const addCmd = program
    .command('add')
    .description(COMMAND_DESCRIPTIONS.add)
    .showHelpAfterError()
    .showSuggestionAfterError();

  // Catch-all argument for invalid subcommands - Commander matches subcommands first
  addCmd.argument('[subcommand]').action((subcommand: string | undefined, _options, cmd) => {
    if (subcommand) {
      console.error(`error: '${subcommand}' is not a valid subcommand.`);
      cmd.outputHelp();
      process.exit(1);
    }

    requireProject();

    const { clear, unmount } = render(
      <AddFlow
        isInteractive={false}
        onExit={() => {
          clear();
          unmount();
        }}
      />
    );
  });

  // Subcommands (agent, memory, credential, gateway, gateway-target) are registered
  // via primitive.registerCommands() in cli.ts

  return addCmd;
}
