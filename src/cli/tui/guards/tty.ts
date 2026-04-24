/**
 * Guard that checks for an interactive terminal and exits if not found.
 * Prevents TUI flows from hanging in CI, piped stdin, or agent automation.
 */
export function requireTTY(): void {
  if (!process.stdout.isTTY) {
    console.error('Error: This command requires an interactive terminal. Use --help to see non-interactive flags.');
    process.exit(1);
  }
}
