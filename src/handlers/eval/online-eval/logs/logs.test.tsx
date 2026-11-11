import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { createRootHandler } from "../../../index";

const ID = "evaluation-1";
const SINCE = 1_709_391_000_000;
const LOG_SOURCE = { logGroupName: "/custom/evaluation-results" };
const EVENTS = [
  { timestamp: new Date(SINCE), message: "first result", logStreamName: "run-a" },
  { timestamp: new Date(SINCE + 1_000), message: "second result", logStreamName: "run-b" },
];

function setup() {
  const core = new TestCoreClient();
  core.eval.logSource = LOG_SOURCE;
  core.observability.logEvents = EVENTS;
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    route: (flags: string[]) =>
      root.route([
        "node",
        "agentcore",
        "eval",
        "online-eval",
        "logs",
        ...flags,
        "--region",
        "us-west-2",
      ]),
  };
}

describe("online-eval logs", () => {
  // Pin a real online evaluation result and its search window. Re-recording
  // requires the configuration and retained CloudWatch event to still exist.
  // Redact account identifiers in recordings before publishing them.
  test.each([
    ["text", false],
    ["json", true],
  ] as const)("searches recorded online evaluation logs as %s", async (format, json) => {
    const fixtures = join(import.meta.dir, "__fixtures__");
    const core = new CoreClient({
      ...fixtureFactories(fixtures),
      logger: createSilentLogger(),
    });
    const io = testIO();
    const root = createRootHandler(core, {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });

    await root.route([
      "node",
      "agentcore",
      "eval",
      "online-eval",
      "logs",
      "--id",
      "bugbash725_MyOnlineEval-x7cbMK8W2z",
      "--since",
      "1781115098000",
      "--until",
      "1781115100000",
      "--limit",
      "1",
      "--region",
      "us-east-1",
      ...(json ? ["--json"] : []),
    ]);

    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain("Builtin.Correctness");
    matchGolden(fixtures, `logs-search-${format}.golden.txt`, io.stdout());
  });

  test("tails the resolved group by default and announces it on stderr", async () => {
    const { core, io, route } = setup();

    await route(["--id", ID]);

    expect(core.observability.calls[0]?.method).toBe("tailLogs");
    expect(core.observability.calls[0]?.args[0]).toEqual(LOG_SOURCE);
    expect(io.stdout()).toBe(
      EVENTS.map((event) => `${event.timestamp.toISOString()}  ${event.message}`).join("\n"),
    );
    expect(io.stderr()).toBe(`Streaming logs for online-eval ${ID}... (Ctrl+C to stop)`);
  });
});

test("requires an explicit resource ID", async () => {
  const { route } = setup();

  await expect(route(["--since", "1h"])).rejects.toThrow("required option '--id' not specified");
});

test.each([
  [
    "online configured output",
    "agentcore_cli_online_eval_role_warn-tSVCZiBf4l",
    "/aws/bedrock-agentcore/evaluations/results/agentcore_cli_online_eval_role_warn-tSVCZiBf4l",
  ],
  [
    "online source output",
    "agentcore_cli_online_eval_fixture-5gZw987afd",
    "/aws/bedrock-agentcore/runtimes/testAgent_Agent-wm9hYBD93Y-DEFAULT",
  ],
] as const)("%s resolves its recorded log group", async (_name, id, logGroupName) => {
  const core = new CoreClient({
    ...fixtureFactories(join(import.meta.dir, "..", "__fixtures__")),
    logger: createSilentLogger(),
  });

  expect(await core.eval.resourceOnlineEvaluationLogSource(id, { region: "us-west-2" })).toEqual({
    logGroupName,
  });
});
