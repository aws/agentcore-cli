/**
 * MCP tool constants for the TUI harness.
 *
 * This module exports the canonical tool names, launch defaults, and the
 * special-key enum array used by the MCP server when registering tools and
 * building Zod schemas.
 *
 * The JSON Schema tool definitions that previously lived here have been
 * removed -- the MCP server defines its schemas inline via Zod.
 */
import { SPECIAL_KEY_VALUES } from '../index.js';

// ---------------------------------------------------------------------------
// Re-export: Special Key Enum
// ---------------------------------------------------------------------------

/**
 * All special key names recognized by the TUI harness.
 *
 * Re-exported from the harness types module so both the harness library and
 * the MCP server share a single source of truth. The underlying constant is
 * `SPECIAL_KEY_VALUES` in `src/tui-harness/lib/types.ts`.
 */
export { SPECIAL_KEY_VALUES as SPECIAL_KEY_ENUM };

// ---------------------------------------------------------------------------
// Tool Name Constants
// ---------------------------------------------------------------------------

/**
 * Canonical tool names used by the MCP server.
 *
 * Use these constants instead of raw strings to avoid typos and enable
 * compile-time checking when wiring tool handlers.
 */
export const TOOL_NAMES = {
  LAUNCH: 'tui_launch',
  SEND_KEYS: 'tui_send_keys',
  READ_SCREEN: 'tui_read_screen',
  WAIT_FOR: 'tui_wait_for',
  SCREENSHOT: 'tui_screenshot',
  CLOSE: 'tui_close',
  LIST_SESSIONS: 'tui_list_sessions',
  ACTION: 'tui_action',
} as const;

// ---------------------------------------------------------------------------
// Launch Defaults
// ---------------------------------------------------------------------------

/**
 * Default command and args for `tui_launch` when not specified by the caller.
 *
 * This makes `tui_launch({})` a convenient shorthand for launching the
 * AgentCore CLI TUI.
 */
export const LAUNCH_DEFAULTS = {
  command: 'node',
  args: ['dist/cli/index.mjs'],
} as const;
