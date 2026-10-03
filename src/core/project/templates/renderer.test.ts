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
});
