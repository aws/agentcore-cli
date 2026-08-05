import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../errors";
import { parseJsonObjectLines } from "./jsonl";

describe("parseJsonObjectLines", () => {
  test("decodes objects and retains their physical line numbers", () => {
    const rows = parseJsonObjectLines('{"a":1}\n\n  \n{"b":2}\n', "'--source'");

    expect(rows).toEqual([
      { value: { a: 1 }, lineNumber: 1 },
      { value: { b: 2 }, lineNumber: 4 },
    ]);
  });

  test("reports malformed JSON with its source, line number, and an excerpt", () => {
    const parse = () => parseJsonObjectLines('{"ok":true}\n{"broken":\n', "'--source'");

    expect(parse).toThrow(InputValidationError);
    expect(parse).toThrow(/'--source'.*line 2/);
    expect(parse).toThrow(/broken/);
  });

  test.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"value"'],
    ["a number", "42"],
    ["a boolean", "true"],
  ])("rejects %s because each line must contain an object", (_description, line) => {
    const parse = () => parseJsonObjectLines(`${line}\n`, "'--source'");

    expect(parse).toThrow(InputValidationError);
    expect(parse).toThrow(/expected a JSON object/);
  });

  test("returns no rows for blank input", () => {
    expect(parseJsonObjectLines("\n  \n", "'--source'")).toEqual([]);
  });
});
