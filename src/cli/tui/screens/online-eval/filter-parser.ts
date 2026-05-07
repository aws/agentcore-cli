// ──────────────────────────────────────────────────────────────────────────────
// Filter parsing helpers for the online-eval `agentcore add` wizard.
//
// Kept as a sibling module (rather than co-located with the React component)
// so it is independently unit-testable.
// ──────────────────────────────────────────────────────────────────────────────

import type { OnlineEvalFilter, OnlineEvalFilterOperator } from '../../../../schema';
import { ONLINE_EVAL_FILTER_OPERATORS } from './types';

/**
 * Render a single filter as the canonical "<key> <operator> <value>" string
 * shown in the confirm screen. Quoting is *not* re-applied to string values
 * because this is for display only; round-trip through the parser is not the
 * goal here.
 */
export function formatFilter(f: OnlineEvalFilter): string {
  const v =
    f.value.stringValue !== undefined
      ? f.value.stringValue
      : f.value.doubleValue !== undefined
        ? String(f.value.doubleValue)
        : f.value.booleanValue !== undefined
          ? String(f.value.booleanValue)
          : '';
  return `${f.key} ${f.operator} ${v}`;
}

/**
 * Parse a filter input string such as:
 *   'model Equals claude-3; latencyMs LessThan 1000; success Equals true'
 *   'id Equals "12345"; flag Equals "true"'
 *
 * Value typing rules:
 *   - Double-quoted value (e.g. "12345") → stringValue (quotes stripped)
 *   - Bare `true` / `false` → booleanValue
 *   - Bare numeric (`-?\d+(\.\d+)?`) → doubleValue
 *   - Anything else → stringValue
 *
 * Returns undefined if any segment is malformed or contains an unknown operator.
 * An empty input (no non-empty segments after splitting on `;`) also returns
 * undefined so callers can distinguish "user cleared the field" from "user
 * supplied at least one filter".
 */
export function parseFiltersInput(input: string): OnlineEvalFilter[] | undefined {
  const segments = input
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (segments.length === 0) return undefined;

  const filters: OnlineEvalFilter[] = [];
  for (const segment of segments) {
    // Match: <key> <operator> <value> where <value> is either a double-quoted
    // string (with no embedded quotes) or a bare token sequence to end of line.
    const match = segment.match(/^(\S+)\s+(\S+)\s+(?:"([^"]*)"|(.+?))\s*$/);
    if (!match) return undefined;
    const key = match[1]!;
    const operator = match[2] as OnlineEvalFilterOperator;
    if (!ONLINE_EVAL_FILTER_OPERATORS.includes(operator)) return undefined;
    const quoted = match[3];
    const bare = match[4];

    let value: OnlineEvalFilter['value'];
    if (quoted !== undefined) {
      // Explicit string — preserves "true", "false", "12345" as strings.
      value = { stringValue: quoted };
    } else {
      const rawValue = bare!;
      if (rawValue === 'true' || rawValue === 'false') {
        value = { booleanValue: rawValue === 'true' };
      } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        value = { doubleValue: parseFloat(rawValue) };
      } else {
        value = { stringValue: rawValue };
      }
    }
    filters.push({ key, operator, value });
  }
  return filters;
}
