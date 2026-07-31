import { describe, expect, test } from "bun:test";
import z from "zod";
import { withTuiOnEmptyFlagsAndArgs } from "./withTuiOnEmptyFlagsAndArgs";
import { Router, createHandler, flag } from "../router";
import { JsonKey } from "../handlers/keys";
import { TestCoreClient, testIO } from "../testing";

// The middleware decides between the TUI and the wrapped handler from what the
// user actually typed. These tests route a real command tree so Commander's
// option-source tracking (cli vs default) is exercised end to end; the TUI
// branch is observable as the renderTui TTY error (testIO is not a TTY), the
// headless branch as the leaf handler running.
function route(args: string[]): { ran: () => boolean; routed: Promise<void> } {
  let handled = false;
  const leaf = createHandler({
    name: "leaf",
    description: "a leaf with only defaulted flags",
    flags: [
      flag("template", "defaulted enum", z.enum(["a", "b"]).default("a")),
      flag("skip-thing", "defaulted boolean", z.boolean().default(false)),
    ],
    handle: async () => {
      handled = true;
    },
  });

  const root = new Router("agentcore", "test root")
    .groupFlags(JsonKey)
    .use(withTuiOnEmptyFlagsAndArgs(new TestCoreClient(), testIO().io))
    .handler(leaf);

  return { ran: () => handled, routed: root.route(["node", "agentcore", "leaf", ...args]) };
}

describe("withTuiOnEmptyFlagsAndArgs", () => {
  test("opens the TUI on a bare invocation even when every flag has a default", async () => {
    const { ran, routed } = route([]);

    await expect(routed).rejects.toThrow("interactive mode requires a TTY on stdin and stdout");
    expect(ran()).toBe(false);
  });

  test("runs the handler when a defaulted flag is passed explicitly", async () => {
    const { ran, routed } = route(["--skip-thing"]);

    await routed;
    expect(ran()).toBe(true);
  });

  test("runs the handler when a value flag is passed explicitly", async () => {
    const { ran, routed } = route(["--template", "b"]);

    await routed;
    expect(ran()).toBe(true);
  });

  test("runs the handler under --json instead of opening the TUI", async () => {
    const { ran, routed } = route(["--json"]);

    await routed;
    expect(ran()).toBe(true);
  });
});
