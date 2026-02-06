/**
 * Simple store for exit messages to be displayed after TUI exits.
 * Used to communicate from screens to the main CLI exit handler.
 */
let exitMessage: string | null = null;

export function setExitMessage(message: string): void {
  exitMessage = message;
}

export function getExitMessage(): string | null {
  return exitMessage;
}

export function clearExitMessage(): void {
  exitMessage = null;
}
