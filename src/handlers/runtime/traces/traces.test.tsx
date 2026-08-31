import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/globalConfig";
import { createRootHandler } from "../../index";
import type { GetRuntimeTraceInput, ListRuntimeTracesInput } from "../types";
import { formatTraceTable, formatTraceTimestamp } from "./list";
import { resolveTraceOutputPath } from "./get/outputPath";
import type { Project } from "../../project/types";

const REGION = "us-west-2";
const SINCE_MS = 1_709_391_000_000;
const UNTIL_MS = 1_709_394_600_000;

function testTracesCommand() {
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

describe("runtime traces list", () => {
  test("queries the window and renders a table", async () => {
    const { core, io, route } = testTracesCommand();
    core.observability.traceSummaries = [
      {
        traceId: "abc123",
        timestamp: "1709391000000",
        sessionId: "session-1",
        spanCount: "7",
      },
      { traceId: "def456", timestamp: "not-a-number" },
    ];

    await route([
      "runtime",
      "traces",
      "list",
      "--id",
      "my_agent-AbC123XyZ9",
      "--since",
      `${SINCE_MS}`,
      "--until",
      `${UNTIL_MS}`,
      "--limit",
      "5",
    ]);

    expect(core.observability.calls).toHaveLength(1);
    const call = core.observability.calls[0]!;
    expect(call.method).toBe("listRuntimeTraces");
    expect(call.args[0] as ListRuntimeTracesInput).toEqual({
      runtimeId: "my_agent-AbC123XyZ9",
      startTimeMs: SINCE_MS,
      endTimeMs: UNTIL_MS,
      limit: 5,
    });

    const [header, first, second] = io.stdout().split("\n");
    expect(header).toMatch(/^TRACE ID\s+TIMESTAMP\s+SESSION ID$/);
    expect(first).toMatch(/^abc123\s+2024-03-02 14:50:00Z\s+session-1$/);
    // A non-numeric timestamp passes through; a missing session renders as "-".
    expect(second).toMatch(/^def456\s+not-a-number\s+-$/);
  });

  test("defaults the limit to 20", async () => {
    const { core, route } = testTracesCommand();

    await route(["runtime", "traces", "list", "--id", "rt-1", "--since", `${SINCE_MS}`]);

    expect((core.observability.calls[0]!.args[0] as ListRuntimeTracesInput).limit).toBe(20);
  });

  test("--json renders a single JSON document", async () => {
    const { core, io, route } = testTracesCommand();
    core.observability.traceSummaries = [{ traceId: "abc123", timestamp: "1709391000000" }];

    await route(["runtime", "traces", "list", "--id", "rt-1", "--json"]);

    expect(JSON.parse(io.stdout())).toEqual({
      traces: [{ traceId: "abc123", timestamp: "1709391000000" }],
    });
  });

  test("an empty result prints a friendly notice on stderr", async () => {
    const { io, route } = testTracesCommand();

    await route(["runtime", "traces", "list", "--id", "rt-1"]);

    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("No traces found in the specified time range");
    expect(io.stderr()).toContain("2-3 minutes");
  });
});

describe("runtime traces get", () => {
  test("downloads the records, writes the JSON file, and prints its path", async () => {
    const { core, io, route } = testTracesCommand();
    core.observability.traceRecords = [
      { "@timestamp": "2026-08-30 12:00:00.000", "@message": { body: "hello" } },
    ];
    const output = join(mkdtempSync(join(tmpdir(), "trace-out-")), "nested", "trace.json");

    await route([
      "runtime",
      "traces",
      "get",
      "abc123def456",
      "--id",
      "my_agent-AbC123XyZ9",
      "--since",
      `${SINCE_MS}`,
      "--output",
      output,
    ]);

    const call = core.observability.calls[0]!;
    expect(call.method).toBe("getRuntimeTrace");
    expect(call.args[0] as GetRuntimeTraceInput).toMatchObject({
      runtimeId: "my_agent-AbC123XyZ9",
      traceId: "abc123def456",
      startTimeMs: SINCE_MS,
    });

    expect(io.stdout()).toBe(output);
    expect(io.stderr()).toContain("Saved 1 records for trace abc123def456");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
      { "@timestamp": "2026-08-30 12:00:00.000", "@message": { body: "hello" } },
    ]);
  });

  test("--json reports the file path and record count", async () => {
    const { core, io, route } = testTracesCommand();
    core.observability.traceRecords = [{ "@message": "a" }, { "@message": "b" }];
    const output = join(mkdtempSync(join(tmpdir(), "trace-out-")), "trace.json");

    await route([
      "runtime",
      "traces",
      "get",
      "abc123",
      "--id",
      "rt-1",
      "--output",
      output,
      "--json",
    ]);

    expect(JSON.parse(io.stdout())).toEqual({ filePath: output, recordCount: 2 });
  });

  test("surfaces core errors (e.g. no trace data) unchanged", async () => {
    const { core, route } = testTracesCommand();
    core.observability.error = new Error("No trace data found for trace ID: abc123");

    await expect(route(["runtime", "traces", "get", "abc123", "--id", "rt-1"])).rejects.toThrow(
      "No trace data found for trace ID: abc123",
    );
  });
});

describe("resolveTraceOutputPath", () => {
  const project = { name: "Proj", rootPath: "/work/proj", spec: {} } as unknown as Project;

  // Expected paths are built with the same node:path primitives the resolver
  // uses: what these tests pin down is which branch wins (--output > project
  // > cwd), not the platform's separator (Windows resolves to drive-letter
  // backslash paths).
  test("an explicit --output wins, resolved against the cwd", () => {
    expect(
      resolveTraceOutputPath({
        output: "out/trace.json",
        project,
        runtimeId: "rt-1",
        traceId: "abc",
        cwd: "/work/elsewhere",
      }),
    ).toBe(resolve("/work/elsewhere", "out/trace.json"));
  });

  test("inside a project the file lands under agentcore/.cli/traces", () => {
    expect(
      resolveTraceOutputPath({ project, runtimeId: "my_agent-AbC", traceId: "abc123", cwd: "/x" }),
    ).toBe(join("/work/proj", "agentcore", ".cli", "traces", "my_agent-AbC-abc123.json"));
  });

  test("outside a project the file lands in the working directory", () => {
    expect(resolveTraceOutputPath({ runtimeId: "rt-1", traceId: "abc123", cwd: "/tmp/x" })).toBe(
      resolve("/tmp/x", "abc123.json"),
    );
  });
});

describe("formatTraceTimestamp", () => {
  test("renders epoch-ms strings as UTC timestamps and passes other text through", () => {
    expect(formatTraceTimestamp("1709391000000")).toBe("2024-03-02 14:50:00Z");
    expect(formatTraceTimestamp("2026-08-30 12:00:00.000")).toBe("2026-08-30 12:00:00.000");
  });
});

describe("formatTraceTable", () => {
  test("pads columns and substitutes '-' for a missing session", () => {
    const table = formatTraceTable([{ traceId: "abc", timestamp: "xyz" }]);
    expect(table).toBe(
      "TRACE ID                          TIMESTAMP             SESSION ID\n" +
        "abc                               xyz                   -\n",
    );
  });
});
