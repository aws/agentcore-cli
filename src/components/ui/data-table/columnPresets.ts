/**
 * Shared column geometry, so the same kind of value is the same width and the
 * same alignment in every table. Before these existed each picker picked its
 * own numbers and `status` ended up anywhere between 12 and 22 cells wide.
 */

/** Fits `2026-08-14 09:41` exactly, the format every timestamp column renders. */
export const TIMESTAMP_WIDTH = 16;

/**
 * Fits the longest status the control plane returns, `UPDATE_UNSUCCESSFUL`
 * (19), plus a cell of breathing room before the next column.
 */
export const STATUS_WIDTH = 20;

/** Version and revision numbers, right-aligned so the digits stack. */
export const VERSION_WIDTH = 7;

/** Small counts and priorities, right-aligned for the same reason. */
export const COUNT_WIDTH = 8;

/**
 * Numeric columns are right-aligned so values of different magnitude share
 * their ones place; text columns keep the default left edge.
 */
export const NUMERIC_ALIGN = "right" as const;

/**
 * Narrow, fixed-vocabulary flag columns (`live`, `target`) hold one or two
 * characters, so centering keeps the value under its own header instead of
 * stranding it at the far left edge of a header twice its width.
 */
export const FLAG_ALIGN = "center" as const;
