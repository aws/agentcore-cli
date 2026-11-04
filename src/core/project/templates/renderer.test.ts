import { describe, expect, test } from "bun:test";
import { HandlebarsTemplateRenderer } from "./renderer";

describe("HandlebarsTemplateRenderer helpers", () => {
  const renderer = new HandlebarsTemplateRenderer();

  test("jsStr renders a single-quoted JavaScript string literal", () => {
    expect(renderer.render("{{jsStr v}}", { v: "global.anthropic.claude" })).toBe(
      "'global.anthropic.claude'",
    );
  });

  test("jsStr escapes quotes, backslashes and newlines", () => {
    expect(renderer.render("{{jsStr v}}", { v: "it's a\\b\nc" })).toBe("'it\\'s a\\\\b\\nc'");
  });

  test("safeJson keeps double quotes for JSON-style output", () => {
    expect(renderer.render("{{safeJson v}}", { v: "a" })).toBe('"a"');
  });

  // escapePyStr feeds a Python triple-double-quoted literal: """{{escapePyStr v}}""".
  // A double-quote left adjacent to the closing """ delimiter merges into """"
  // and breaks the literal, so every quote must be escaped.
  test("escapePyStr escapes a trailing double-quote so it cannot merge with the closing delimiter", () => {
    expect(renderer.render("{{escapePyStr v}}", { v: 'answer in "quotes"' })).toBe(
      'answer in \\"quotes\\"',
    );
  });
});
