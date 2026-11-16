import { types } from "node:util";

const isRawJson = (
  JSON as typeof JSON & {
    isRawJSON?: (value: unknown) => value is { rawJSON: string };
  }
).isRawJSON;

// Node 20 cannot emit raw JSON from a replacer. Track BigInts by their position
// among string values, then unquote only those tokens without revisiting the input.
export function stringifyJson(value: unknown, space?: number): string {
  const bigIntPositions = new Set<number>();
  let stringPosition = 0;
  const json = JSON.stringify(
    value,
    (_key, val: unknown) => {
      if (typeof val === "bigint") {
        bigIntPositions.add(stringPosition++);
        return val.toString();
      }
      if (
        typeof val === "string" ||
        types.isStringObject(val) ||
        (isRawJson?.(val) && val.rawJSON.startsWith('"'))
      ) {
        stringPosition++;
      }
      return val;
    },
    space,
  );
  if (bigIntPositions.size === 0) return json;

  stringPosition = 0;
  // Match whole JSON strings (including escapes); a following colon identifies a key.
  return json.replace(
    /"[^"\\]*(?:\\.[^"\\]*)*"(\s*:)?/g,
    (token: string, key: string | undefined) => {
      if (key !== undefined) return token;
      return bigIntPositions.has(stringPosition++) ? token.slice(1, -1) : token;
    },
  );
}
