import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { KeyHint, type KeyHintItem } from "./KeyHint";

afterEach(cleanup);

function renderAtWidth(keys: KeyHintItem[], columns: number): string {
  const instance = render(<></>);
  Object.defineProperty(instance.stdout, "columns", {
    configurable: true,
    value: columns,
  });
  instance.stdout.emit("resize");
  instance.rerender(<KeyHint keys={keys} />);
  return instance.lastFrame() ?? "";
}

describe("KeyHint", () => {
  test("excludes a double-width hint that does not fit", () => {
    const frame = renderAtWidth(
      [
        { key: "界", label: "go" },
        { key: "enter", label: "select" },
      ],
      22,
    );

    expect(frame).not.toContain("[界] go");
    expect(frame).toContain("[enter] select");
  });

  test("includes a combining-character hint when its terminal cells fit", () => {
    const frame = renderAtWidth(
      [
        { key: "e\u0301", label: "go" },
        { key: "enter", label: "select" },
      ],
      22,
    );

    expect(frame).toContain("[e\u0301] go");
    expect(frame).toContain("[enter] select");
  });
});
