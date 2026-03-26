/**
 * Screen reader utilities for extracting text content from an xterm Terminal buffer.
 *
 * This module provides functions that read the xterm buffer's internal line
 * data and return plain-text representations of the terminal screen. It
 * supports reading just the visible viewport, reading the full scrollback
 * history, retrieving cursor position and buffer type, and composing a
 * complete ScreenState snapshot.
 *
 * All functions accept a Terminal instance that must have been created with
 * `allowProposedApi: true` (required to access `terminal.buffer`).
 */
import type { ReadOptions, ScreenState } from './types.js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

// ---------------------------------------------------------------------------
// Individual readers
// ---------------------------------------------------------------------------

/**
 * Read the visible viewport lines from the active buffer.
 *
 * The viewport starts at `baseY` (the first visible row when scrolled to the
 * bottom) and spans `terminal.rows` lines.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An array of strings, one per visible row, with trailing whitespace trimmed.
 */
export function readViewport(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const start = buffer.baseY;
  const lines: string[] = [];

  for (let i = start; i < start + terminal.rows; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }

  return lines;
}

/**
 * Read all lines in the active buffer, including scrollback history.
 *
 * Returns every line from index 0 through `baseY + terminal.rows - 1`,
 * covering the full scrollback plus the visible viewport.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An array of strings for every line in the buffer.
 */
export function readWithScrollback(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const totalLines = buffer.baseY + terminal.rows;
  const lines: string[] = [];

  for (let i = 0; i < totalLines; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }

  return lines;
}

/**
 * Get the current cursor position in the active buffer.
 *
 * The coordinates are 0-indexed and relative to the viewport (not the
 * scrollback). `cursorY` ranges from 0 to `terminal.rows - 1`.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns An object with `x` and `y` properties.
 */
export function getCursor(terminal: Terminal): { x: number; y: number } {
  const buffer = terminal.buffer.active;
  return { x: buffer.cursorX, y: buffer.cursorY };
}

/**
 * Determine whether the terminal is using the normal or alternate screen buffer.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @returns `'normal'` or `'alternate'`.
 */
export function getBufferType(terminal: Terminal): 'normal' | 'alternate' {
  return terminal.buffer.active.type;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an array of lines with right-aligned, 1-indexed line numbers.
 *
 * Example output for a 3-line array:
 * ```
 *   1 | first line
 *   2 | second line
 *   3 | third line
 * ```
 *
 * @param lines - The lines to number.
 * @returns A single string with newline-separated numbered lines.
 */
export function formatNumbered(lines: string[]): string {
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`).join('\n');
}

// ---------------------------------------------------------------------------
// Composite snapshot
// ---------------------------------------------------------------------------

/**
 * Build a complete ScreenState snapshot from the terminal.
 *
 * @param terminal - An xterm Terminal instance with allowProposedApi enabled.
 * @param options - Optional ReadOptions controlling scrollback inclusion and numbering.
 * @returns A ScreenState object containing lines, cursor, dimensions, and buffer type.
 */
export function buildScreenState(terminal: Terminal, options?: ReadOptions): ScreenState {
  let lines = options?.includeScrollback ? readWithScrollback(terminal) : readViewport(terminal);

  if (options?.numbered) {
    const width = String(lines.length).length;
    lines = lines.map((line, i) => `${String(i + 1).padStart(width)} | ${line}`);
  }

  return {
    lines,
    cursor: getCursor(terminal),
    dimensions: { cols: terminal.cols, rows: terminal.rows },
    bufferType: getBufferType(terminal),
  };
}
