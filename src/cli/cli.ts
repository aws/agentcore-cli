import { getOrCreateInstallationId } from '../lib/schemas/io/global-config';
import { registerABTestCommand } from './commands/abtest';
import { registerAdd } from './commands/add';
import { registerAddTool } from './commands/add/tool-command';
import { registerArchive } from './commands/archive';
import { registerConfig } from './commands/config';
import { registerConfigBundle } from './commands/config-bundle';
import { registerCreate } from './commands/create';
import { registerDataset } from './commands/dataset';
import { registerDeploy } from './commands/deploy';
import { registerDev } from './commands/dev';
import { registerEval } from './commands/eval';
import { registerFeedback } from './commands/feedback';
import { registerFetch } from './commands/fetch';
import { registerHelp } from './commands/help';
import { registerImport } from './commands/import';
import { registerInvoke } from './commands/invoke';
import { registerLogs } from './commands/logs';
import { registerPackage } from './commands/package';
import { registerPause, registerPromote } from './commands/pause';
import { registerRecommendations } from './commands/recommendations';
import { registerRemove } from './commands/remove';
import { registerRemoveTool } from './commands/remove/tool-command';
import { registerResume } from './commands/resume';
import { registerRun } from './commands/run';
import { registerStatus } from './commands/status';
import { registerStop } from './commands/stop';
import { registerTelemetry } from './commands/telemetry';
import { registerTraces } from './commands/traces';
import { registerUpdate } from './commands/update';
import { registerValidate } from './commands/validate';
import { COMMAND_DESCRIPTIONS, PACKAGE_VERSION } from './constants';
import { isPreviewEnabled } from './feature-flags';
import { printPostCommandNotices, printTelemetryNotice } from './notices';
import { ALL_PRIMITIVES } from './primitives';
import { TelemetryClientAccessor } from './telemetry';
import { renderTUI, setupAltScreenCleanup } from './tui';
import { LayoutProvider } from './tui/context';
import { clearExitMessage, getExitMessage } from './tui/exit-message';
import { requireTTY } from './tui/guards';
import { CommandListScreen } from './tui/screens/home';
import { getCommandsForUI } from './tui/utils';
import { checkForUpdate } from './update-notifier';
import { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import React from 'react';

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
  registerFeedback(program);
  registerFetch(program);
  registerHelp(program);
  registerImport(program);
  registerInvoke(program);
  registerLogs(program);
  registerPackage(program);
  registerPause(program);
  registerRecommendations(program);
  const removeCmd = registerRemove(program);
  registerResume(program);
  registerRun(program);
  registerStatus(program);
  registerStop(program);
  registerPromote(program);
  registerTelemetry(program);
  registerTraces(program);
  registerUpdate(program);
  registerValidate(program);
  registerConfigBundle(program);
  registerConfig(program);
  registerDataset(program);
  registerArchive(program);

  // Register primitive subcommands (add agent, remove agent, add memory, etc.)
  for (const primitive of ALL_PRIMITIVES) {
    primitive.registerCommands(addCmd, removeCmd);
  }

  // Register standalone add/remove subcommands (preview-only)
  if (isPreviewEnabled()) {
    registerAddTool(addCmd);
    registerRemoveTool(removeCmd);
  }

  // Register AB test detail command
  registerABTestCommand(program);
}

export const main = async (argv: string[]) => {
  // Register global cleanup handlers once at startup
  setupAltScreenCleanup();

  // Generate installationId on first run and show telemetry notice. If we
  // could not persist the id, suppress the notice so it doesn't fire every run.
  const installationIdResult = await getOrCreateInstallationId();
  const isFirstRun = installationIdResult.success && installationIdResult.created;

  const program = createProgram();

  const args = argv.slice(2);

  // Fire off non-blocking update check (skip for `update` command itself)
  const isUpdateCommand = args[0] === 'update';
  const updateCheck = isUpdateCommand ? Promise.resolve(null) : checkForUpdate();

  // Show TUI for no arguments, commander handles --help via configureHelp()
  if (args.length === 0) {
    requireTTY();
    await renderTUI({ updateCheck, isFirstRun });
    return;
  }

  if (isFirstRun) {
    await printTelemetryNotice();
  }

  await TelemetryClientAccessor.init(args[0] ?? 'unknown');
  try {
    await program.parseAsync(argv);
  } finally {
    await TelemetryClientAccessor.shutdown();
  }

  // Telemetry notice already printed above; only run update check here.
  await printPostCommandNotices(false, updateCheck);

  const exitMessage = getExitMessage();
  if (exitMessage) {
    console.log(`\n${exitMessage}`);
    clearExitMessage();
  }
};
