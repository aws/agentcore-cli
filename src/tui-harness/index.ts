/**
 * Public API surface for the TUI test harness.
 *
 * This barrel file re-exports only the symbols intended for external
 * consumption. Internal implementation details (SettlingMonitor, screen
 * reader helpers, session registry internals) are deliberately excluded.
 *
 * Import convention:
 *   import { TuiSession, isAvailable, closeAll } from '../tui-harness/index.js';
 */

// --- Core session class ---
export { TuiSession } from './lib/tui-session.js';

// --- Types and error classes ---
export type { LaunchOptions, ScreenState, ReadOptions, CloseResult, SessionInfo } from './lib/types.js';
export type { SpecialKey } from './lib/types.js';
export { SPECIAL_KEY_VALUES, WaitForTimeoutError, LaunchError } from './lib/types.js';

// --- Key mapping ---
export { KEY_MAP, resolveKey } from './lib/key-map.js';

// --- Availability ---
export { isAvailable, unavailableReason } from './lib/availability.js';

// --- Session management (for test cleanup) ---
export { closeAll } from './lib/session-manager.js';

// --- Test helpers ---
export { createMinimalProjectDir } from './helpers.js';
export type { CreateMinimalProjectDirOptions, MinimalProjectDirResult } from './helpers.js';
