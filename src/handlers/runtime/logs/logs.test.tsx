import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/globalConfig";
import { createRootHandler } from "../../index";
import type { SearchRuntimeLogsInput, StreamRuntimeLogsInput } from "../types";

const REGION = "us-west-2";

// Fixed epoch bounds keep the tests clock-independent.
const SINCE_MS = 1_709_391_000_000;
const UNTIL_MS = 1_709_394_600_000;

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
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
  };
}

describe("runtime logs", () => {
  test("searches when --since/--until are given and renders human lines", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logEvents = [
      { timestamp: SINCE_MS, message: "hello world\n" },
      { timestamp: SINCE_MS + 1_000, message: "second line" },
    ];

    await route([
      "runtime",
      "logs",
      "--id",
      "my_agent-AbC123XyZ9",
      "--since",
      `${SINCE_MS}`,
      "--until",
      `${UNTIL_MS}`,
    ]);

    expect(core.observability.calls).toHaveLength(1);
    const call = core.observability.calls[0]!;
    expect(call.method).toBe("searchRuntimeLogs");
    expect(call.args[0] as SearchRuntimeLogsInput).toEqual({
      runtimeId: "my_agent-AbC123XyZ9",
      startTimeMs: SINCE_MS,
      endTimeMs: UNTIL_MS,
      filterPattern: undefined,
      limit: undefined,
    });
    expect(call.args[1]).toEqual({ region: REGION, endpointUrl: undefined });

    // Human mode: `<ISO time>  <message>` with the trailing newline normalized.
    expect(io.stdout()).toBe(
      "2024-03-02T14:50:00.000Z  hello world\n2024-03-02T14:50:01.000Z  second line",
    );
  });

  test("--json emits one JSON object per event (JSON Lines)", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logEvents = [{ timestamp: SINCE_MS, message: "hello" }];

    await route([
      "runtime",
      "logs",
      "--id",
      "my_agent-AbC123XyZ9",
      "--since",
      `${SINCE_MS}`,
      "--json",
    ]);

    expect(io.stdout()).toBe('{"timestamp":"2024-03-02T14:50:00.000Z","message":"hello"}');
  });

  test("level and query compose into a CloudWatch filter pattern", async () => {
    const { core, route } = testLogsCommand();

    await route([
      "runtime",
      "logs",
      "--id",
      "rt-1",
      "--since",
      "1709391000000",
      "--level",
      "ERROR",
      "--query",
      "database",
      "--limit",
      "25",
    ]);

    const input = core.observability.calls[0]!.args[0] as SearchRuntimeLogsInput;
    // --level is case-insensitive, like the old CLI.
    expect(input.filterPattern).toBe("ERROR database");
    expect(input.limit).toBe(25);
  });

  test("rejects an invalid --level", async () => {
    const { route } = testLogsCommand();

    await expect(route(["runtime", "logs", "--id", "rt-1", "--level", "loud"])).rejects.toThrow(
      "Invalid value for option '--level'",
    );
  });

  test("follows by default, announcing the stream on stderr", async () => {
    const { core, io, route } = testLogsCommand();
    core.observability.logEvents = [{ timestamp: SINCE_MS, message: "tailed" }];

    await route(["runtime", "logs", "--id", "my_agent-AbC123XyZ9"]);

    expect(core.observability.calls).toHaveLength(1);
    const call = core.observability.calls[0]!;
    expect(call.method).toBe("streamRuntimeLogs");
    expect(call.args[0] as StreamRuntimeLogsInput).toEqual({
      runtimeId: "my_agent-AbC123XyZ9",
      filterPattern: undefined,
    });
    expect(io.stderr()).toContain(
      "Streaming logs for runtime my_agent-AbC123XyZ9... (Ctrl+C to stop)",
    );
    expect(io.stdout()).toBe("2024-03-02T14:50:00.000Z  tailed");
  });

  test("rejects --limit outside search mode", async () => {
    const { route } = testLogsCommand();

    await expect(route(["runtime", "logs", "--id", "rt-1", "--limit", "5"])).rejects.toThrow(
      "--limit applies to search mode; add --since and/or --until",
    );
  });

  test("rejects an unparseable --since", async () => {
    const { route } = testLogsCommand();

    await expect(
      route(["runtime", "logs", "--id", "rt-1", "--since", "yesterday-ish"]),
    ).rejects.toThrow('Invalid time string: "yesterday-ish"');
  });

  test("auto-resolves the project's deployed runtime when --id is omitted", async () => {
    const { core, route } = testLogsCommand();

    // A minimal-but-valid project for the on-disk project resolution.
    const root = mkdtempSync(join(tmpdir(), "logs-project-"));
    mkdirSync(join(root, "agentcore"), { recursive: true });
    writeFileSync(
      join(root, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "LogsProj", version: 1 }),
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await route(["runtime", "logs", "--since", `${SINCE_MS}`]);
    } finally {
      process.chdir(previousCwd);
    }

    const [resolveCall, searchCall] = core.observability.calls;
    expect(resolveCall!.method).toBe("resolveDeployedRuntime");
    expect(resolveCall!.args[1]).toBe("default");
    expect(searchCall!.method).toBe("searchRuntimeLogs");
    // The stubbed deployed runtime (and its target region) win over --region.
    expect((searchCall!.args[0] as SearchRuntimeLogsInput).runtimeId).toBe(
      "project_runtime-0000000000",
    );
    expect(searchCall!.args[1]).toMatchObject({
      region: core.observability.resolveDeployedRuntimeResponse.region,
    });
  });
});
