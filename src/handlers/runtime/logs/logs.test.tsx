import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/globalConfig";
import { createRootHandler } from "../../index";
import type { LogSource } from "../../../core/observability/index";

const REGION = "us-west-2";

const SINCE_MS = 1_709_391_000_000;

function testLogsCommand() {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    core,
    io,
    route: (args: string[]) => root.route(["bun", "agentcore", ...args, "--region", REGION]),
  };
}

describe("runtime logs", () => {
  test("rejects an invalid --level", async () => {
    const { route } = testLogsCommand();

    await expect(route(["runtime", "logs", "--id", "rt-1", "--level", "loud"])).rejects.toThrow(
      "Invalid value for option '--level'",
    );
  });

  test("follows by default, announcing the stream on stderr", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logEvents = [{ timestamp: new Date(SINCE_MS), message: "tailed" }];

    await route(["runtime", "logs", "--id", "my_agent-AbC123XyZ9"]);

    expect(core.observability.calls).toHaveLength(1);
    const call = core.observability.calls[0]!;
    expect(call.method).toBe("tailLogs");
    expect(call.args[0] as LogSource).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
    });
    expect(call.args[1]).toEqual({
      filterPattern: undefined,
    });
    expect(io.stderr()).toContain(
      "Streaming logs for runtime my_agent-AbC123XyZ9... (Ctrl+C to stop)",
    );
    expect(io.stdout()).toBe("2024-03-02T14:50:00.000Z  tailed");
  });

  test("uses the requested endpoint qualifier", async () => {
    const { core, route } = testLogsCommand();

    await route([
      "runtime",
      "logs",
      "--id",
      "my_agent-AbC123XyZ9",
      "--qualifier",
      "live",
      "--since",
      "1h",
    ]);

    expect(core.observability.calls[0]?.args[0]).toEqual({
      logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-live",
    });
  });

  test("rejects --limit outside search mode", async () => {
    const { route } = testLogsCommand();

    await expect(route(["runtime", "logs", "--id", "rt-1", "--limit", "5"])).rejects.toThrow(
      "--limit applies to search mode; add --since and/or --until",
    );
  });

  test("rejects --tail with a bounded search", async () => {
    const { route } = testLogsCommand();

    await expect(
      route(["runtime", "logs", "--id", "rt-1", "--tail", "--since", "1h"]),
    ).rejects.toThrow("--tail cannot be combined with --since or --until");
  });

  test("requires --id even when invoked inside a project", async () => {
    const { core, route } = testLogsCommand();

    // An imperative Runtime command must not fall back to project resolution.
    const root = mkdtempSync(join(tmpdir(), "logs-project-"));
    mkdirSync(join(root, "agentcore"), { recursive: true });
    writeFileSync(
      join(root, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "LogsProj", version: 1 }),
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await expect(route(["runtime", "logs", "--since", `${SINCE_MS}`])).rejects.toThrow(
        "required option '--id <id>' not specified",
      );
    } finally {
      process.chdir(previousCwd);
    }

    expect(core.observability.calls).toHaveLength(0);
  });
});
