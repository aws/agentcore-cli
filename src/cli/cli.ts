import { registerAdd } from './commands/add';
import { registerCreate } from './commands/create';
import { registerDeploy } from './commands/deploy';
import { registerDev } from './commands/dev';
import { registerEval } from './commands/eval';
import { registerFetch } from './commands/fetch';
import { registerHelp } from './commands/help';
import { registerImport } from './commands/import';
import { registerInvoke } from './commands/invoke';
import { registerLogs } from './commands/logs';
import { registerPackage } from './commands/package';
import { registerPause } from './commands/pause';
import { registerRemove } from './commands/remove';
import { registerResume } from './commands/resume';
import { registerRun } from './commands/run';
import { registerStatus } from './commands/status';
import { registerTelemetry } from './commands/telemetry';
import { registerTraces } from './commands/traces';
import { registerUpdate } from './commands/update';
import { registerValidate } from './commands/validate';
import { PACKAGE_VERSION } from './constants';
import { getOrCreateInstallationId } from './global-config';
import { ALL_PRIMITIVES } from './primitives';
import { App } from './tui/App';
import { LayoutProvider } from './tui/context';
import { COMMAND_DESCRIPTIONS } from './tui/copy';
import { clearExitAction, getExitAction } from './tui/exit-action';
import { clearExitMessage, getExitMessage } from './tui/exit-message';
import { requireTTY } from './tui/guards';
import { CommandListScreen } from './tui/screens/home';
import { getCommandsForUI } from './tui/utils';
import { type UpdateCheckResult, checkForUpdate, printUpdateNotification } from './update-notifier';
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

function printTelemetryNotice(): void {
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  process.stderr.write(
    [
      '',
      `${yellow}The AgentCore CLI will soon begin collecting aggregated, anonymous usage`,
      'analytics to help improve the tool.',
      'To opt out:          agentcore telemetry disable',
      `To learn more:       agentcore telemetry --help${reset}`,
      '',
      '',
    ].join('\n')
  );
}

function printPostCommandNotices(isFirstRun: boolean, updateCheck: Promise<UpdateCheckResult | null>): Promise<void> {
  if (isFirstRun) {
    printTelemetryNotice();
  }
  return updateCheck.then(result => {
    if (result?.updateAvailable) {
      printUpdateNotification(result);
    }
  });
}

/**
 * Render the TUI in alternate screen buffer mode.
 */
function renderTUI(updateCheck: Promise<UpdateCheckResult | null>, isFirstRun: boolean) {
  inAltScreen = true;
  process.stdout.write(ENTER_ALT_SCREEN);

  const { waitUntilExit } = render(React.createElement(App));

  void waitUntilExit().then(async () => {
    inAltScreen = false;
    process.stdout.write(EXIT_ALT_SCREEN);
    process.stdout.write(SHOW_CURSOR);

    // Check if the TUI requested a post-exit action (e.g., launch browser dev mode)
    const action = getExitAction();
    clearExitAction();

    if (action?.type === 'dev') {
      const { launchBrowserDev } = await import('./commands/dev/browser-mode');
      await launchBrowserDev();
      return;
    }

    // Print any exit message set by screens (e.g., after successful project creation)
    const exitMessage = getExitMessage();
    if (exitMessage) {
      console.log(exitMessage);
      clearExitMessage();
    }

    await printPostCommandNotices(isFirstRun, updateCheck);
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

  // Add help footer to all subcommands explaining interactive vs non-interactive
  const helpFooter =
    '\nRun without flags for interactive mode. Flags marked [non-interactive] trigger CLI mode.\nRun `agentcore help modes` for details.';
  program.commands.forEach(cmd => {
    cmd.addHelpText('after', helpFooter);
    // Also add to nested subcommands (e.g., add agent, remove agent)
    cmd.commands.forEach(subcmd => {
      subcmd.addHelpText('after', helpFooter);
    });
  });

  return program;
}

export function registerCommands(program: Command) {
  const addCmd = registerAdd(program);
  registerDev(program);
  registerDeploy(program);
  registerCreate(program);
  registerEval(program);
  registerFetch(program);
  registerHelp(program);
  registerImport(program);
  registerInvoke(program);
  registerLogs(program);
  registerPackage(program);
  registerPause(program);
  const removeCmd = registerRemove(program);
  registerResume(program);
  registerRun(program);
  registerStatus(program);
  registerTelemetry(program);
  registerTraces(program);
  registerUpdate(program);
  registerValidate(program);

  // Register primitive subcommands (add agent, remove agent, add memory, etc.)
  for (const primitive of ALL_PRIMITIVES) {
    primitive.registerCommands(addCmd, removeCmd);
  }
}

export const main = async (argv: string[]) => {
  // Register global cleanup handlers once at startup
  setupGlobalCleanup();

  // Generate installationId on first run and show telemetry notice
  const { created: isFirstRun } = await getOrCreateInstallationId();

  const program = createProgram();

  const args = argv.slice(2);

  // Fire off non-blocking update check (skip for `update` command)
  const isUpdateCommand = args[0] === 'update';
  const updateCheck = isUpdateCommand ? Promise.resolve(null) : checkForUpdate();

  // Show TUI for no arguments, commander handles --help via configureHelp()
  if (args.length === 0) {
    requireTTY();
    renderTUI(updateCheck, isFirstRun);
    return;
  }

  if (isFirstRun) {
    printTelemetryNotice();
  }

  await program.parseAsync(argv);

  // Telemetry notice already printed above; only run update check here.
  await printPostCommandNotices(false, updateCheck);

  const exitMessage = getExitMessage();
  if (exitMessage) {
    console.log(`\n${exitMessage}`);
    clearExitMessage();
  }
};
