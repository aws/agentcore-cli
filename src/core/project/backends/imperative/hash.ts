import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level, so two structurally equal
 * values serialize identically regardless of insertion order. Arrays keep
 * their order: for a request, order is meaning (skills, tools, statements).
 * `undefined`-valued keys are dropped, as JSON.stringify would drop them.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Hex SHA-256 of a value's stable serialization. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
