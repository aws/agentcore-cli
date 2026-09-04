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
  test("shows only complete high-priority hints that fit one row", () => {
    const frame = renderAtWidth(
      [
        { key: "enter", label: "send" },
        { key: "⇧↵", label: "newline" },
        { key: "ctrl+t", label: "target" },
        { key: "↑↓", label: "scroll" },
        { key: "esc", label: "back" },
        { key: "ctrl+c", label: "quit" },
      ],
      60,
    );

    expect(frame).toBe("[enter] send  [⇧↵] newline  [↑↓] scroll  [esc] back");
  });
});
