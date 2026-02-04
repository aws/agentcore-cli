import { registerAdd } from './commands/add';
import { registerAttach } from './commands/attach';
import { registerCreate } from './commands/create';
import { registerDeploy } from './commands/deploy';
import { registerDestroy } from './commands/destroy';
import { registerDev } from './commands/dev';
import { registerInvoke } from './commands/invoke';
import { registerOutline } from './commands/outline';
import { registerPackage } from './commands/package';
import { registerRemove } from './commands/remove';
import { registerStatus } from './commands/status';
import { registerStopSession } from './commands/stop-session';
import { registerUpdate } from './commands/update';
import { registerValidate } from './commands/validate';
import { PACKAGE_VERSION } from './constants';
import { App } from './tui/App';
import { LayoutProvider } from './tui/context';
import { COMMAND_DESCRIPTIONS } from './tui/copy';
import { CommandListScreen } from './tui/screens/home';
import { getCommandsForUI } from './tui/utils';
import { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

// ANSI escape sequences
const ENTER_ALT_SCREEN = '\x1B[?1049h\x1B[H';
const EXIT_ALT_SCREEN = '\x1B[?1049l';
const SHOW_CURSOR = '\x1B[?25h';

// Track if we're in alternate screen mode
let inAltScreen = false;

/**
 * Global terminal cleanup - ensures cursor is always restored on exit.
 * Registered once at startup, catches all exit scenarios.
 */
function setupGlobalCleanup() {
  const cleanup = () => {
    if (inAltScreen) {
      process.stdout.write(EXIT_ALT_SCREEN);
    }
    process.stdout.write(SHOW_CURSOR);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}

/**
 * Render the TUI in alternate screen buffer mode.
 */
function renderTUI() {
  inAltScreen = true;
  process.stdout.write(ENTER_ALT_SCREEN);

  const { waitUntilExit } = render(React.createElement(App));

  void waitUntilExit().then(() => {
    inAltScreen = false;
    process.stdout.write(EXIT_ALT_SCREEN);
    process.stdout.write(SHOW_CURSOR);
  });
}

function renderHelp(program: Command): void {
  const commands = getCommandsForUI(program);
  render(React.createElement(LayoutProvider, null, React.createElement(CommandListScreen, { commands })));
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentcore')
    .description(COMMAND_DESCRIPTIONS.program)
    .version(PACKAGE_VERSION)
    .showHelpAfterError()
    .showSuggestionAfterError();

  // Custom help only for main program
  program.addHelpCommand(false); // Disable default help subcommand
  program.helpOption('-h, --help', 'Display help');

  // Override help action for main program only
  program.on('option:help', () => {
    renderHelp(program);
    process.exit(0);
  });

  registerCommands(program);

  return program;
}

export function registerCommands(program: Command) {
  registerAdd(program);
  registerAttach(program);
  registerDev(program);
  registerDeploy(program);
  registerDestroy(program);
  registerCreate(program);
  registerInvoke(program);
  registerOutline(program);
  registerPackage(program);
  registerRemove(program);
  registerStatus(program);
  registerStopSession(program);
  registerUpdate(program);
  registerValidate(program);
}

export const main = async (argv: string[]) => {
  // Register global cleanup handlers once at startup
  setupGlobalCleanup();

  const program = createProgram();

  // Show TUI for no arguments, commander handles --help via configureHelp()
  const args = argv.slice(2);
  if (args.length === 0) {
    renderTUI();
    return;
  }

  await program.parseAsync(argv);
};
