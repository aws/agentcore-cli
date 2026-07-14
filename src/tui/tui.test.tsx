import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../handlers";
import { renderJson } from "./index";
import { TestCoreClient, testExecutionPolicy, testIO } from "../testing";

describe("renderJson", () => {
  test("pretty-prints a value as indented JSON to the given writer", () => {
    const lines: string[] = [];
    renderJson({ a: 1, b: ["x"] }, (line) => lines.push(line));
    expect(lines).toEqual(['{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}']);
  });
});

describe("--json short-circuits the TUI", () => {
  // With --json set, a group invoked without a subcommand prints help text
  // instead of launching the interactive TUI (renderTui's JSON branch). This
  // keeps the CLI scriptable and, importantly, keeps these tests from trying to
  // mount Ink against a non-TTY stdin.
  async function runRoot(args: string[]): Promise<string> {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), io.io);
    await root.route(["node", "agentcore", ...args, "--json"], testExecutionPolicy());
    return io.stdout();
  }

  test("bare `agentcore --json` prints help rather than opening the TUI", async () => {
    const out = await runRoot([]);
    expect(out).toContain("Usage:");
    expect(out).toContain("harness");
  });

  test("`agentcore harness --json` prints the harness command's help", async () => {
    const out = await runRoot(["harness"]);
    expect(out).toContain("Usage:");
    // The harness subcommands are listed in its help.
    expect(out).toContain("list");
    expect(out).toContain("get");
  });
});
