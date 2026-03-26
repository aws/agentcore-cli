/**
 * Mapping from human-readable special key names to xterm-256color escape sequences.
 *
 * The TUI test harness uses this module to translate high-level key names
 * (e.g. "enter", "ctrl+c", "f5") into the raw byte sequences that a terminal
 * emulator would send to a PTY. This allows test code to express key presses
 * declaratively rather than embedding opaque escape codes.
 *
 * The `satisfies Record<SpecialKey, string>` constraint guarantees at compile
 * time that every member of the SpecialKey union has a corresponding entry.
 * Adding a new key to SpecialKey without updating KEY_MAP will produce a
 * type error.
 */
import type { SpecialKey } from './types.js';

/**
 * Exhaustive map from every {@link SpecialKey} to its xterm-256color byte sequence.
 *
 * Navigation keys use CSI (ESC [ ...) sequences. Function keys f1-f4 use
 * SS3 (ESC O ...) sequences; f5-f12 use CSI with tilde-suffixed codes.
 * Ctrl combos map to their traditional ASCII control characters.
 */
export const KEY_MAP = {
  // Basic editing keys
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',

  // Arrow keys (CSI sequences)
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',

  // Navigation keys
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',

  // Ctrl combinations (ASCII control characters)
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+q': '\x11',
  'ctrl+g': '\x07',
  'ctrl+a': '\x01',
  'ctrl+e': '\x05',
  'ctrl+w': '\x17',
  'ctrl+u': '\x15',
  'ctrl+k': '\x0b',

  // Function keys f1-f4 (SS3 sequences)
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',

  // Function keys f5-f12 (CSI tilde sequences)
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
} as const satisfies Record<SpecialKey, string>;

/**
 * Resolve a special key name to its terminal escape sequence.
 *
 * @param key - A member of the {@link SpecialKey} union.
 * @returns The raw byte sequence for the given key.
 */
export function resolveKey(key: SpecialKey): string {
  return KEY_MAP[key];
}
