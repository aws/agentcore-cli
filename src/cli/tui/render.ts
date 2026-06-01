import { ANSI } from '../constants';
import { printPostCommandNotices } from '../notices';
import { TelemetryClientAccessor } from '../telemetry';
import { type UpdateCheckResult } from '../update-notifier';
import { App, type InitialRoute } from './App';
import { clearExitAction, getExitAction } from './exit-action';
import { clearExitMessage, getExitMessage } from './exit-message';
import { render } from 'ink';
import React from 'react';

const { enterAltScreen: ENTER_ALT_SCREEN, exitAltScreen: EXIT_ALT_SCREEN, showCursor: SHOW_CURSOR } = ANSI;

let inAltScreen = false;

export interface RenderTUIOptions {
  /** Route to navigate to on launch. If omitted, shows the default home/help screen. */
  initialRoute?: InitialRoute;
  /** Promise that resolves with update check result. Used to print update notifications on exit. Default: Promise.resolve(null) */
  updateCheck?: Promise<UpdateCheckResult | null>;
  /** Whether this is the first time the CLI has been run. Shows telemetry notice on exit. Default: false */
  isFirstRun?: boolean;
  /** Control whether TUI is rendered inline or in alternate screen. Default: true */
  enterAltScreen?: boolean;
  /** Behavior when pressing escape/back. 'help' navigates to the help screen, 'exit' exits the app. Default: 'help' */
  actionOnBack?: 'help' | 'exit';
  /** Whether the TUI is running in full interactive mode. When false, screens auto-exit after success. Default: true */
  isInteractive?: boolean;
}

/**
 * Render the TUI in alternate screen buffer mode.
 * This is the entrypoint for all TUI operations.
 */
export async function renderTUI(options: RenderTUIOptions = {}) {
  const {
    initialRoute,
    updateCheck = Promise.resolve(null),
    isFirstRun = false,
    enterAltScreen: useAltScreen = true,
    actionOnBack = 'help',
    isInteractive = true,
  } = options;
  await TelemetryClientAccessor.init(initialRoute?.name ?? 'tui', 'tui');
  if (useAltScreen) {
    inAltScreen = true;
    process.stdout.write(ENTER_ALT_SCREEN);
  }

  const { waitUntilExit } = render(React.createElement(App, { initialRoute, actionOnBack, isInteractive }));

  await waitUntilExit();

  if (inAltScreen) {
    inAltScreen = false;
    process.stdout.write(EXIT_ALT_SCREEN);
    process.stdout.write(SHOW_CURSOR);
  }

  // Flush telemetry before blocking process
  const telemetryClient = await TelemetryClientAccessor.get();
  if (telemetryClient) {
    await telemetryClient.flush();
  }

  // Check if the TUI requested a post-exit action (e.g., launch browser dev mode)
  const action = getExitAction();
  clearExitAction();

  if (action?.type === 'dev') {
    const { launchBrowserDev } = await import('../commands/dev/browser-mode');
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
}

/**
 * Cleanup handler for alternate screen on process signals.
 * Call once at startup.
 */
export function setupAltScreenCleanup() {
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
