import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { Divider } from "./Divider";
import { waitFor } from "../../../testing";

afterEach(cleanup);

function resize(stdout: NodeJS.WriteStream, columns: number) {
  Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
  stdout.emit("resize");
}

describe("Divider", () => {
  test("spans the terminal and follows it when the window is resized", async () => {
    const instance = render(<></>);
    const stdout = instance.stdout as unknown as NodeJS.WriteStream;
    resize(stdout, 60);
    instance.rerender(<Divider />);
    expect(instance.lastFrame()).toBe("─".repeat(60));

    resize(stdout, 40);
    await waitFor(() => instance.lastFrame() === "─".repeat(40));

    resize(stdout, 70);
    await waitFor(() => instance.lastFrame() === "─".repeat(70));
  });

  test("an explicit width ignores the terminal width", () => {
    const instance = render(<Divider title="Title" width={20} />);
    expect(instance.lastFrame()).toBe("── Title ───────────");
  });
});
