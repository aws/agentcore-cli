import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../handlers";
import { ExitCode, InvalidEnvironmentError } from "../errors";
import { renderJson } from "./index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  ttyTestIO,
  tick,
  waitFor,
} from "../testing";

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
    expect(out).toMatch(/^\s+create\s+/m);
    expect(out).toMatch(/^\s+harness\s+/m);
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

describe("TUI resize", () => {
  const ERASE_SCREEN = "\u001B[2J\u001B[H";

  function resize(stdout: NodeJS.WriteStream, columns: number, rows = stdout.rows) {
    Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
    Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
    stdout.emit("resize");
  }

  test("shrinking redraws once after resizing settles", async () => {
    const { streams, stdin } = ttyTestIO(120, 40);
    const root = createRootHandler(new TestCoreClient(), {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const routePromise = root.route(["node", "agentcore"]);
    await waitFor(() => streams.stdout().includes("deploy"));
    await tick();

    const beforeNarrow = streams.stdout().length;
    resize(streams.io.stdout, 110, 38);
    resize(streams.io.stdout, 100, 35);
    resize(streams.io.stdout, 90, 30);
    expect(streams.stdout()).toHaveLength(beforeNarrow);

    await waitFor(() => {
      const resized = streams.stdout().slice(beforeNarrow);
      const clearAt = resized.indexOf(ERASE_SCREEN);
      return clearAt >= 0 && resized.indexOf("deploy", clearAt) > clearAt;
    });
    expect(streams.stdout().slice(beforeNarrow).split(ERASE_SCREEN)).toHaveLength(2);

    const beforeWiden = streams.stdout().length;
    resize(streams.io.stdout, 100, 35);
    await waitFor(() => streams.stdout().length > beforeWiden);
    expect(streams.stdout().slice(beforeWiden)).not.toContain(ERASE_SCREEN);

    stdin.write(String.fromCharCode(3));
    await expect(routePromise).resolves.toBeUndefined();
    expect(streams.io.stdout.listenerCount("resize")).toBe(0);
  });

  test("repaints when a shrink gesture returns to the cached size", async () => {
    const { streams, stdin } = ttyTestIO(100, 40);
    const root = createRootHandler(new TestCoreClient(), {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const routePromise = root.route(["node", "agentcore"]);
    await waitFor(() => streams.stdout().includes("deploy"));
    await tick();

    const beforeResize = streams.stdout().length;
    resize(streams.io.stdout, 100, 15);
    resize(streams.io.stdout, 100, 40);
    expect(streams.stdout()).toHaveLength(beforeResize);

    await waitFor(() => {
      const resized = streams.stdout().slice(beforeResize);
      const clearAt = resized.indexOf(ERASE_SCREEN);
      return clearAt >= 0 && resized.indexOf("deploy", clearAt) > clearAt;
    });

    stdin.write(String.fromCharCode(3));
    await expect(routePromise).resolves.toBeUndefined();
  });
});
