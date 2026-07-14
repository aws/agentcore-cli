import { test, expect, describe, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { ValueContext, compile, CommandKey } from "../router";
import { createRootHandler } from "./index";
import { HelpScreen } from "./screen";
import { TestCoreClient, testExecutionPolicy, testIO } from "../testing";

afterEach(cleanup);

// HelpScreen is the `*` fallback route: it prints the current command's help and
// exits. Because it unmounts itself on mount (useEffect(exit)), it is tested in
// isolation here rather than through the mounted app, reading the first frame it
// renders before the exit effect runs.

describe("HelpScreen", () => {
  test("renders the command's help text", () => {
    const command = compile(
      createRootHandler(new TestCoreClient(), testIO().io),
      ValueContext.EmptyContext(),
      testExecutionPolicy(),
    );
    const ctx = ValueContext.EmptyContext().withValue(CommandKey, command);

    const { frames } = render(<HelpScreen ctx={ctx} core={new TestCoreClient()} />);

    // The help text is produced synchronously on the first render.
    const output = frames.join("\n");
    expect(output).toContain("Usage:");
    expect(output).toContain("harness");
    expect(output).toContain("config");
  });
});
