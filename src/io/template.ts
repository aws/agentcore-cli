import { InputValidationError } from "../errors";

// renderJsonTemplate substitutes `{key}` placeholders inside the string values of a
// JSON template and returns the encoded bytes. General on purpose: `simulate` uses
// `{ input }`, but any `{model}`/`{sessionId}` a future caller adds works the same.
// Parsing the template first (rather than string-replacing raw) keeps the result
// valid JSON regardless of quotes/newlines in the substituted values.
export function renderJsonTemplate(
  template: string,
  values: Record<string, string>,
  flagName = "payload-template",
): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new InputValidationError(`--${flagName} must be valid JSON`);
  }
  return new TextEncoder().encode(JSON.stringify(substitute(parsed, values)));
}

function substitute(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, values)]),
    );
  }
  return value;
}
