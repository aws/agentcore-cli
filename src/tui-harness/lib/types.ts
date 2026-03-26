/**
 * Type definitions and error classes for the TUI test harness.
 *
 * This module defines all interfaces, types, and custom error classes used
 * throughout the harness. It has no runtime dependencies beyond the standard
 * library, so it can be imported freely without pulling in node-pty or xterm.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Options for launching a TUI session.
 *
 * @property command - The executable to spawn (e.g. "/usr/bin/node", "agentcore").
 * @property args - Arguments passed to the command. Defaults to [].
 * @property cwd - Working directory for the spawned process.
 * @property cols - Terminal width in columns. Defaults to 100.
 * @property rows - Terminal height in rows. Defaults to 30.
 * @property env - Additional environment variables merged with process.env.
 */
export interface LaunchOptions {
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/**
 * A snapshot of the terminal screen at a point in time.
 *
 * @property lines - Array of strings, one per terminal row. Each string is
 *   the text content of that row with trailing whitespace trimmed.
 * @property cursor - The current cursor position (0-indexed).
 * @property dimensions - The terminal dimensions at capture time.
 * @property bufferType - Whether the terminal is using the normal or
 *   alternate screen buffer.
 */
export interface ScreenState {
  lines: string[];
  cursor: { x: number; y: number };
  dimensions: { cols: number; rows: number };
  bufferType: 'normal' | 'alternate';
}

/**
 * Options for reading the terminal screen.
 *
 * @property includeScrollback - When true, include lines above the visible
 *   viewport (scrollback history). Defaults to false.
 * @property numbered - When true, prefix each line with its 1-indexed line
 *   number. Defaults to false.
 */
export interface ReadOptions {
  includeScrollback?: boolean;
  numbered?: boolean;
}

/**
 * Result from sending keys to a TUI session.
 *
 * @property screen - The screen state after output settles.
 * @property settled - Whether the terminal output fully settled within the
 *   wait period. When `false`, the hard ceiling timeout was reached and the
 *   screen content may still be updating.
 */
export interface SendResult {
  screen: ScreenState;
  settled: boolean;
}

/**
 * Result returned when a TUI session is closed.
 *
 * @property exitCode - The process exit code, or null if terminated by signal.
 * @property signal - The signal that terminated the process (e.g. "SIGTERM"),
 *   or null if it exited normally.
 * @property finalScreen - The last screen state captured before the process
 *   exited.
 */
export interface CloseResult {
  exitCode: number | null;
  signal: string | null;
  finalScreen: ScreenState;
}

/**
 * Metadata about an active (or recently closed) TUI session.
 *
 * @property sessionId - Unique identifier for this session.
 * @property pid - Operating system process ID of the PTY child process.
 * @property command - The command that was launched.
 * @property cwd - The working directory of the spawned process.
 * @property dimensions - Current terminal dimensions.
 * @property bufferType - Current buffer type (normal or alternate).
 * @property alive - Whether the PTY process is still running.
 * @property created - Timestamp when the session was created.
 */
export interface SessionInfo {
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  dimensions: { cols: number; rows: number };
  bufferType: 'normal' | 'alternate';
  alive: boolean;
  created: Date;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All special key names recognized by the TUI harness, as a compile-time
 * constant array. This is the single source of truth for the key list.
 *
 * The {@link SpecialKey} type is derived from this array, and `key-map.ts`
 * uses `satisfies Record<SpecialKey, string>` to guarantee exhaustive
 * coverage at compile time.
 */
export const SPECIAL_KEY_VALUES = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'delete',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'ctrl+c',
  'ctrl+d',
  'ctrl+q',
  'ctrl+g',
  'ctrl+a',
  'ctrl+e',
  'ctrl+w',
  'ctrl+u',
  'ctrl+k',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
] as const;

/**
 * Union of all special key names recognized by the harness input methods.
 *
 * Derived from {@link SPECIAL_KEY_VALUES} so the array and the type are
 * always in sync.
 */
export type SpecialKey = (typeof SPECIAL_KEY_VALUES)[number];

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a `waitFor` call exceeds its timeout without matching the
 * expected pattern on screen.
 *
 * The error message includes the pattern that was being waited for, the
 * elapsed time, and a dump of the non-empty screen lines at the time of
 * failure to aid debugging.
 */
export class WaitForTimeoutError extends Error {
  public readonly pattern: string | RegExp;
  public readonly elapsed: number;
  public readonly screen: ScreenState;

  constructor(pattern: string | RegExp, elapsed: number, screen: ScreenState) {
    const nonEmptyLines = screen.lines.filter(line => line.trim() !== '');
    const screenDump = nonEmptyLines.join('\n');
    const patternStr = pattern instanceof RegExp ? pattern.toString() : `"${pattern}"`;

    super(
      `Timed out after ${elapsed}ms waiting for ${patternStr}\n` +
        `Screen (${nonEmptyLines.length} non-empty lines):\n${screenDump}`
    );

    this.name = 'WaitForTimeoutError';
    this.pattern = pattern;
    this.elapsed = elapsed;
    this.screen = screen;
  }
}

/**
 * Thrown when a TUI process fails to launch or exits unexpectedly during
 * session setup.
 *
 * The error message includes the command, arguments, working directory,
 * exit code, and a dump of the non-empty screen lines to aid debugging.
 */
export class LaunchError extends Error {
  public readonly command: string;
  public readonly args: string[];
  public readonly cwd: string;
  public readonly exitCode: number | null;
  public readonly screen: ScreenState;

  constructor(command: string, args: string[], cwd: string, exitCode: number | null, screen: ScreenState) {
    const nonEmptyLines = screen.lines.filter(line => line.trim() !== '');
    const screenDump = nonEmptyLines.join('\n');

    super(
      `Failed to launch: ${command} ${args.join(' ')}\n` +
        `  cwd: ${cwd}\n` +
        `  exitCode: ${exitCode}\n` +
        `Screen (${nonEmptyLines.length} non-empty lines):\n${screenDump}`
    );

    this.name = 'LaunchError';
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.screen = screen;
  }
}
