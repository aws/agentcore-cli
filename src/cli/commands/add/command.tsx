import { COMMAND_DESCRIPTIONS } from '../../constants';
import { renderTUI } from '../../tui';
import { requireProject, requireTTY } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export function registerAdd(program: Command): Command {
  const addCmd = program
    .command('add')
    .description(COMMAND_DESCRIPTIONS.add)
    .showHelpAfterError()
    .showSuggestionAfterError();

  // Catch-all argument for invalid subcommands - Commander matches subcommands first
  addCmd.argument('[subcommand]').action(async (subcommand: string | undefined, _options, cmd) => {
    if (subcommand) {
      console.error(`error: '${subcommand}' is not a valid subcommand.`);
      cmd.outputHelp();
      process.exit(0);
    }

    requireProject();
    requireTTY();

    await renderTUI({
      initialRoute: { name: 'add' },
      enterAltScreen: false,
      actionOnBack: 'exit',
      isInteractive: false,
    });
  });

  // Subcommands (agent, memory, credential, gateway, gateway-target) are registered
  // via primitive.registerCommands() in cli.ts

  return addCmd;
}
