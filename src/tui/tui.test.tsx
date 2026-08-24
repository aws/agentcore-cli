import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../handlers";
import { InvalidEnvironmentError } from "../errors";
import { renderJson } from "./index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  tick,
  waitFor,
} from "../testing";
import { ExitCode } from "../runnable";

interface TtyInput extends NodeJS.ReadStream {
  write(chunk: string): boolean;
}

function ttyTestIO(): { streams: ReturnType<typeof testIO>; stdin: TtyInput } {
  const streams = testIO({ isTTY: true });
  const stdin = streams.io.stdin as TtyInput;
  stdin.setRawMode = function () {
    return this;
  };
  stdin.ref = function () {
    return this;
  };
  stdin.unref = function () {
    return this;
  };
  Object.defineProperties(streams.io.stdout, {
    columns: { configurable: true, value: 100 },
    rows: { configurable: true, value: 40 },
  });
  return { streams, stdin };
}

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
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    await root.route(["node", "agentcore", ...args, "--json"]);
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

describe("TUI stream boundary", () => {
  test.each([
    ["stdin and stdout", false, false],
    ["stdin", false, true],
    ["stdout", true, false],
  ] as const)(
    "rejects interactive mode when %s is non-TTY",
    async (_label, stdinIsTTY, stdoutIsTTY) => {
      const io = testIO({ isTTY: true });
      Object.defineProperty(io.io.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
      Object.defineProperty(io.io.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
      const root = createRootHandler(new TestCoreClient(), {
        io: io.io,
        logger: createSilentLogger(),
        globalConfigAccessor: new TestGlobalConfigAccessor(),
      });

      const error = await root.route(["node", "agentcore"]).catch((error) => error);
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect(error.exitCode).toBe(ExitCode.USAGE);
    },
  );

  test("Ctrl+C exits a Runtime list and ignores input after exit", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [
        {
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
          agentRuntimeId: "runtime-123",
          agentRuntimeVersion: "7",
          agentRuntimeName: "checkout",
          description: "Checkout Runtime",
          lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
          status: "READY",
        },
      ],
      nextToken: "page-2",
    });
    const { streams, stdin } = ttyTestIO();
    const root = createRootHandler(core, {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const routePromise = root.route(["node", "agentcore", "runtime", "list"]);
    const listCalls = () => core.runtime.calls.filter((call) => call.method === "listRuntimes");

    await waitFor(() => listCalls().length > 0);
    await tick();
    const callsBeforeExit = listCalls().length;

    stdin.write(String.fromCharCode(3));
    await expect(routePromise).resolves.toBeUndefined();

    stdin.write("l");
    await tick();
    expect(listCalls()).toHaveLength(callsBeforeExit);
    expect(listCalls().some((call) => call.args[0] === "page-2")).toBe(false);
  });
});
