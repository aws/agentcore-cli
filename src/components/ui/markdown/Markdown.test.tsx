import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { Markdown } from "./Markdown";

afterEach(cleanup);

function renderMarkdown(content: string): string {
  return render(<Markdown content={content} />).lastFrame() ?? "";
}

describe("Markdown", () => {
  test("keeps a marker that opens no span as literal text", () => {
    expect(renderMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(renderMarkdown("items[0] is the first")).toBe("items[0] is the first");
    expect(renderMarkdown("a stray ` backtick")).toBe("a stray ` backtick");
    expect(renderMarkdown("approx ~~10")).toBe("approx ~~10");
    expect(renderMarkdown("an **unclosed bold")).toBe("an **unclosed bold");
  });

  test("still renders closed spans without their markers", () => {
    expect(renderMarkdown("**bold**, *italic*, `code` and [docs](https://example.com)")).toBe(
      "bold, italic, code and docs (https://example.com)",
    );
  });
});
