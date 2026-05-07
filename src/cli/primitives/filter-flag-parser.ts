import type { FilterRule, FilterValue } from '../../schema';
import { FILTER_OPERATORS, FilterRuleSchema } from '../../schema';

/**
 * Parse a single `--filter` CLI argument into a {@link FilterRule}.
 *
 * DSL: `key=<k>,op=<Operator>,type=<string|double|boolean>,value=<v>`
 *
 * - All four keys are required.
 * - Order does not matter.
 * - `type=string` keeps `value` verbatim (so `value=true` stays the string `"true"`).
 * - `type=double` parses with `Number(...)`.
 * - `type=boolean` requires `value` to be exactly `true` or `false`.
 * - Throws a descriptive Error on any malformed input.
 */
export function parseFilterFlag(raw: string): FilterRule {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Empty --filter value');
  }

  const entries = new Map<string, string>();
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      throw new Error(`Invalid --filter syntax near "${part.trim()}". Expected key=value pairs separated by commas.`);
    }
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) {
      throw new Error(`Invalid --filter syntax: empty key in "${raw}"`);
    }
    if (entries.has(k)) {
      throw new Error(`Duplicate --filter key "${k}" in "${raw}"`);
    }
    entries.set(k, v);
  }

  const required = ['key', 'op', 'type', 'value'] as const;
  for (const r of required) {
    if (!entries.has(r)) {
      throw new Error(`--filter is missing required field "${r}". Got: "${raw}"`);
    }
  }

  const key = entries.get('key')!;
  const op = entries.get('op')!;
  const type = entries.get('type')!;
  const valueStr = entries.get('value')!;

  if (!(FILTER_OPERATORS as readonly string[]).includes(op)) {
    throw new Error(`Invalid --filter op "${op}". Must be one of: ${FILTER_OPERATORS.join(', ')}`);
  }

  let value: FilterValue;
  switch (type) {
    case 'string':
      value = { stringValue: valueStr };
      break;
    case 'double': {
      const n = Number(valueStr);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid --filter value "${valueStr}" for type=double`);
      }
      value = { doubleValue: n };
      break;
    }
    case 'boolean':
      if (valueStr !== 'true' && valueStr !== 'false') {
        throw new Error(`Invalid --filter value "${valueStr}" for type=boolean (must be "true" or "false")`);
      }
      value = { booleanValue: valueStr === 'true' };
      break;
    default:
      throw new Error(`Invalid --filter type "${type}". Must be one of: string, double, boolean`);
  }

  const parsed = FilterRuleSchema.safeParse({ key, operator: op, value });
  if (!parsed.success) {
    throw new Error(`--filter failed schema validation: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  }
  return parsed.data;
}

/** Parse multiple `--filter` flags. */
export function parseFilterFlags(raws: string[] | undefined): FilterRule[] | undefined {
  if (!raws || raws.length === 0) return undefined;
  return raws.map(parseFilterFlag);
}
