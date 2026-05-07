/** Polling interval in ms for checking recommendation status. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Statuses that indicate a recommendation has reached a terminal state. */
export const TERMINAL_STATUSES = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'DELETING']);

/** Max retries for transient poll failures (network errors, 5xx). */
export const MAX_POLL_RETRIES = 3;

/** Max total polling duration in ms (30 minutes). */
export const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
