// ────────────────────────────────────────────────────────────────────────────
// Filter input parser for the Add Online Eval Config wizard.
//
// Extracted into a sibling module so it can be unit-tested without rendering
// the React component, and so the same parser is shared between the wizard's
// customValidation gate and its onSubmit handler.
// ────────────────────────────────────────────────────────────────────────────
import type { OnlineEvalFilter } from './types';
import { ONLINE_EVAL_FILTER_OPERATORS } from './types';

/**
 * Parse a user-entered JSON string into a list of OnlineEvalFilter objects.
 *
 * Returns an empty array for empty input. Returns an error message string on
 * failure; otherwise returns the validated filter list.
 */
export function parseFiltersInput(raw: string): OnlineEvalFilter[] | string {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'Invalid JSON';
  }
  if (!Array.isArray(parsed)) return 'Must be a JSON array of filter objects';
  const result: OnlineEvalFilter[] = [];
  for (const f of parsed) {
    if (!f || typeof f !== 'object') return 'Each filter must be an object';
    const obj = f as { key?: unknown; operator?: unknown; value?: unknown };
    if (typeof obj.key !== 'string' || obj.key.length === 0) return 'Each filter requires a non-empty "key" string';
    if (typeof obj.operator !== 'string' || !(ONLINE_EVAL_FILTER_OPERATORS as string[]).includes(obj.operator)) {
      return `operator must be one of: ${ONLINE_EVAL_FILTER_OPERATORS.join(', ')}`;
    }
    if (!obj.value || typeof obj.value !== 'object') return 'Each filter requires a "value" object';
    const v = obj.value as { stringValue?: unknown; doubleValue?: unknown; booleanValue?: unknown };
    const value: { stringValue?: string; doubleValue?: number; booleanValue?: boolean } = {};
    let count = 0;
    if (typeof v.stringValue === 'string') {
      value.stringValue = v.stringValue;
      count++;
    }
    if (typeof v.doubleValue === 'number') {
      value.doubleValue = v.doubleValue;
      count++;
    }
    if (typeof v.booleanValue === 'boolean') {
      value.booleanValue = v.booleanValue;
      count++;
    }
    if (count !== 1) return 'Filter value must have exactly one of stringValue, doubleValue, booleanValue';
    result.push({
      key: obj.key,
      operator: obj.operator as OnlineEvalFilter['operator'],
      value,
    });
  }
  return result;
}
