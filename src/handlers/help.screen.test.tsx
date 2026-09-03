import { test, expect, describe, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { ValueContext, compile, CommandKey } from "../router";
import { createRootHandler } from "./index";
import { HelpScreen } from "./screen";
import { createSilentLogger, TestCoreClient, TestGlobalConfigAccessor, testIO } from "../testing";

afterEach(cleanup);

// HelpScreen is the final `*` fallback for paths that are not exact commands:
// it prints the launching command's help and exits. Because it unmounts itself
// on mount, test its synchronous first frame in isolation.
describe("HelpScreen", () => {
  test("renders the command's help text", () => {
    const command = compile(
      createRootHandler(new TestCoreClient(), {
        io: testIO().io,
        logger: createSilentLogger(),
        globalConfigAccessor: new TestGlobalConfigAccessor(),
      }),
      ValueContext.EmptyContext(),
    );
    const ctx = ValueContext.EmptyContext().withValue(CommandKey, command);

    const { frames } = render(<HelpScreen ctx={ctx} core={new TestCoreClient()} />);

    const output = frames.join("\n");
    expect(output).toContain("Usage:");
    expect(output).toContain("harness");
    expect(output).toContain("config");
  });
});
