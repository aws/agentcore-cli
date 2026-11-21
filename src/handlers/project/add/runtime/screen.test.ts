import { describe, expect, test } from "bun:test";
import { summaryOf } from "./screen";

describe("summaryOf", () => {
  const values = { name: "search", language: "python", protocol: "HTTP" } as const;

  test("shows the docs-only runtime outside a Box project", () => {
    expect(summaryOf(values)).toEqual({
      runtime: "search",
      language: "Python",
      protocol: "HTTP",
      folder: "app/search/ (README.md, AGENTS.md)",
      entrypoint: "main.py",
    });
  });

  test("shows start.py and the box profile in a Box project, as add runtime writes them", () => {
    expect(summaryOf(values, true)).toEqual({
      runtime: "search",
      language: "Python",
      protocol: "HTTP",
      folder: "app/search/ (README.md, AGENTS.md, start.py)",
      entrypoint: "start.py",
      "box profile": ".box/search/local/profile.toml",
    });
  });
});
