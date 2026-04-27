/**
 * Simple store for post-exit actions to be executed after TUI exits.
 * Used to communicate from screens to the main CLI exit handler
 * when a screen needs to hand off to a non-TUI mode (e.g., browser dev).
 */

export type ExitAction = { type: 'dev' } | null;

let exitAction: ExitAction = null;

export function setExitAction(action: ExitAction): void {
  exitAction = action;
}

export function getExitAction(): ExitAction {
  return exitAction;
}

export function clearExitAction(): void {
  exitAction = null;
}
