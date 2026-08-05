import { InputValidationError } from "../errors";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonObjectLine = {
  value: JsonObject;
  lineNumber: number;
};

const EXCERPT_LIMIT = 120;

// parseJsonObjectLines decodes one JSON object per non-blank line. The source
// name is display text (for example, "'--source'") used in validation errors.
export function parseJsonObjectLines(text: string, sourceName: string): JsonObjectLine[] {
  const rows: JsonObjectLine[] = [];

  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const lineNumber = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new InputValidationError(
        `Invalid JSON in ${sourceName} at line ${lineNumber}: ` +
          `${error instanceof Error ? error.message : String(error)}\n  ${excerpt(line)}`,
        { cause: error, meta: { line: lineNumber } },
      );
    }

    if (!isJsonObject(parsed)) {
      throw new InputValidationError(
        `Invalid JSON in ${sourceName} at line ${lineNumber}: expected a JSON object\n  ` +
          excerpt(line),
        { meta: { line: lineNumber } },
      );
    }

    rows.push({ value: parsed, lineNumber });
  });

  return rows;
}

function excerpt(line: string): string {
  return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT)}...` : line;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
