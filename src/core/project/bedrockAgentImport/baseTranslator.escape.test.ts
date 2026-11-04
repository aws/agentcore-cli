import { describe, expect, test } from "bun:test";
import { escapePythonTripleQuoted } from "./baseTranslator";

// escapePythonTripleQuoted escapes a value for embedding inside a Python
// triple-double-quoted literal: SYSTEM_PROMPT = """<escaped>""". For the result
// to be a valid literal, no double-quote in the value may abut the closing
// delimiter — a trailing `"` (or `""`) merges with `"""` into `""""`, which
// Python reads as a closed string plus a dangling quote (a syntax error).
describe("escapePythonTripleQuoted", () => {
  test("escapes a trailing double-quote so it does not merge with the closing delimiter", () => {
    const escaped = escapePythonTripleQuoted('Always answer in "quotes"');
    // Embedded as """<escaped>""", a trailing unescaped quote merges with the
    // closing delimiter into """" and breaks the literal; the quote must be escaped.
    expect(escaped).toBe('Always answer in \\"quotes\\"');
  });

  test("still escapes an interior triple-quote run", () => {
    expect(escapePythonTripleQuoted('emit """ here')).toBe('emit \\"\\"\\" here');
  });
});
