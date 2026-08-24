import { test, expect, describe } from "bun:test";
import {
  GetAgentRuntimeCommand,
  GetEvaluatorCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { EvaluateCommand, type BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  GetQueryResultsCommand,
  ResourceNotFoundException,
  StartQueryCommand,
  type CloudWatchLogsClient,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import { CoreClient } from "../../../core";
import { CloudWatchQueryError, ResourceNotFoundError } from "../../../errors";
import type { Logger } from "../../../logging";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  testIO,
  TestGlobalConfigAccessor,
} from "../../../testing";
import type { EvaluateResult, SessionTrace } from "../types";

// Command-flow tests for `eval ondemand evaluate`, driven through the real root
// handler against a TestCoreClient (no network). These cover the handler's
// orchestration (getTracesForAgent → evaluate), source-arm validation, and the
// local window resolution. The end-to-end SDK path (Insights + Evaluate) is proven
// by the golden fixture suite, which must be recorded against a live account.

const TRACE: SessionTrace = {
  sessionId: "s1",
  spans: [{ traceId: "t1", spanId: "sp1" }],
  traceIds: ["t1"],
  toolCallSpanIds: [],
};

const RESULT: EvaluateResult = {
  sessionsRequested: 1,
  sessionsEvaluated: 1,
  results: [
    { evaluatorId: "Builtin.Helpfulness", value: 0.9 } as EvaluateResult["results"][number],
  ],
};

const RUNTIME_ID = "runtime-1";
const RUNTIME_LOG_GROUP = "/aws/bedrock-agentcore/runtimes/runtime-1-DEFAULT";

type QueryFailureStatus = "Failed" | "Cancelled" | "Timeout";

type LogsOptions = {
  malformedRows?: ResultField[][];
  missingRuntimeLogGroup?: boolean;
  status?: QueryFailureStatus;
};

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  core.eval.setGetTracesResponse([TRACE]).setEvaluateResponse(RESULT);
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout(), stderr: io.stderr() };
}

// Drives the real CoreClient (not TestCoreClient) so the failure paths below run
// through the actual Insights→Evaluate SDK translation, stubbing the `.send()` seam
// inline rather than via the golden fixture harness. The fixture harness records
// against a live account, and these are conditions it can't provoke there: a query
// that resolves Failed/Cancelled/Timeout, a runtime log group missing while
// aws/spans exists, and malformed telemetry rows (whose test also needs a capturing
// logger the fixture `run()` helper doesn't expose). Inline stubs make them deterministic.
async function runWithRealCore(options: LogsOptions, logger = createSilentLogger()) {
  const control = {
    send: async (command: unknown) => {
      if (command instanceof GetAgentRuntimeCommand) {
        return { agentRuntimeId: RUNTIME_ID, agentRuntimeName: "agent-1" };
      }
      if (command instanceof GetEvaluatorCommand) {
        return { evaluatorId: "Builtin.Helpfulness", level: "SESSION" };
      }
      throw new Error(`unexpected control command: ${(command as object).constructor.name}`);
    },
  } as unknown as BedrockAgentCoreControlClient;

  const data = {
    send: async (command: unknown) => {
      if (command instanceof EvaluateCommand) return { evaluationResults: [] };
      throw new Error(`unexpected data command: ${(command as object).constructor.name}`);
    },
  } as unknown as BedrockAgentCoreClient;

  const logs = {
    send: async (command: unknown) => {
      if (command instanceof StartQueryCommand) {
        const logGroup = command.input.logGroupNames?.[0];
        if (options.missingRuntimeLogGroup && logGroup !== "aws/spans") {
          throw new ResourceNotFoundException({
            $metadata: {},
            message: "log group does not exist",
          });
        }
        return { queryId: logGroup === "aws/spans" ? "shared-query" : "runtime-query" };
      }
      if (command instanceof GetQueryResultsCommand) {
        return {
          status: options.status ?? "Complete",
          results: command.input.queryId === "runtime-query" ? (options.malformedRows ?? []) : [],
        };
      }
      throw new Error(`unexpected logs command: ${(command as object).constructor.name}`);
    },
  } as unknown as CloudWatchLogsClient;

  const core = new CoreClient({
    createControlClient: () => control,
    createDataClient: () => data,
    createIamClient: () => ({}) as IAMClient,
    createLogsClient: () => logs,
    logger,
  });
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route([
    "node",
    "agentcore",
    "eval",
    "ondemand",
    "evaluate",
    "--agent",
    RUNTIME_ID,
    "--evaluator",
    "Builtin.Helpfulness",
    "--session-ids",
    "session-1",
    "--region",
    "us-west-2",
  ]);
}

function telemetryRow(sessionId: string, message: string): ResultField[] {
  return [
    { field: "@message", value: message },
    { field: "sessionId", value: sessionId },
  ];
}

const BASE = [
  "eval",
  "ondemand",
  "evaluate",
  "--agent",
  "a-1",
  "--evaluator",
  "Builtin.Helpfulness",
];

describe("eval ondemand command hierarchy", () => {
  test("registers evaluate under eval → ondemand", () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const group = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "ondemand");
    expect(group?.children().map((c) => c.name())).toEqual(["evaluate"]);
  });
});

describe("eval ondemand evaluate validation", () => {
  test.each<[string, string[], RegExp]>([
    [
      "requires --agent",
      ["eval", "ondemand", "evaluate", "--evaluator", "Builtin.Helpfulness", "--session-ids", "s1"],
      /--agent/,
    ],
    [
      "requires --evaluator",
      ["eval", "ondemand", "evaluate", "--agent", "a-1", "--session-ids", "s1"],
      /--evaluator/,
    ],
    ["rejects an empty session source", BASE, /session source/],
    [
      "rejects --lookback-days combined with an explicit window",
      [
        ...BASE,
        "--lookback-days",
        "7",
        "--start-time",
        "2026-01-01T00:00:00Z",
        "--end-time",
        "2026-01-02T00:00:00Z",
      ],
      /cannot be combined/,
    ],
    [
      "rejects a half-open explicit window",
      [...BASE, "--start-time", "2026-01-01T00:00:00Z"],
      /together/,
    ],
    [
      "rejects start-time not before end-time",
      [...BASE, "--start-time", "2026-01-02T00:00:00Z", "--end-time", "2026-01-01T00:00:00Z"],
      /before/,
    ],
  ])("%s", async (_name, args, expectedError) => {
    await expect(run(args)).rejects.toThrow(expectedError);
  });
});

describe("eval ondemand evaluate orchestration", () => {
  test("session-ids arm: fetches traces then evaluates them, rendering the result", async () => {
    const { core, stdout } = await run([...BASE, "--session-ids", "s1", "s2"]);

    expect(JSON.parse(stdout)).toEqual(RESULT);

    const fetch = core.eval.calls.find((c) => c.method === "getTracesForAgent");
    expect(fetch?.args[0]).toMatchObject({
      agent: "a-1",
      sessionIds: ["s1", "s2"],
      window: undefined,
    });

    // evaluate receives exactly the traces getTracesForAgent returned.
    const evaluate = core.eval.calls.find((c) => c.method === "evaluate");
    expect(evaluate?.args[0]).toMatchObject({
      traces: [TRACE],
      evaluatorIds: ["Builtin.Helpfulness"],
    });
    // Order: fetch precedes evaluate.
    expect(core.eval.calls.map((c) => c.method)).toEqual(["getTracesForAgent", "evaluate"]);
  });

  test("--trace-id alone is a valid source and is passed to the fetch", async () => {
    const { core } = await run([...BASE, "--trace-id", "t1"]);
    const fetch = core.eval.calls.find((c) => c.method === "getTracesForAgent");
    expect(fetch?.args[0]).toMatchObject({ traceId: "t1" });
  });

  test("--lookback-days resolves to a now-N-days window (start before end)", async () => {
    const { core } = await run([...BASE, "--lookback-days", "7"]);
    const fetch = core.eval.calls.find((c) => c.method === "getTracesForAgent");
    expect(fetch).toBeDefined();
    const input = fetch!.args[0] as { window?: { startTime: Date; endTime: Date } };
    expect(input.window).toBeDefined();
    const window = input.window!;
    expect(+window.startTime).toBeLessThan(+window.endTime);
    const spanDays = (+window.endTime - +window.startTime) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(7, 5);
  });

  test("ground-truth is parsed and passed to evaluate verbatim", async () => {
    const groundTruth = [
      { context: { spanContext: { sessionId: "s1" } }, expectedResponse: { text: "hi" } },
    ];
    const { core } = await run([
      ...BASE,
      "--session-ids",
      "s1",
      "--ground-truth",
      JSON.stringify(groundTruth),
    ]);
    const evaluate = core.eval.calls.find((c) => c.method === "evaluate");
    expect(evaluate?.args[0]).toMatchObject({ groundTruth });
  });
});

describe("eval ondemand evaluate telemetry failures", () => {
  test("reports a missing runtime log group as ResourceNotFoundError", async () => {
    const error = await runWithRealCore({ missingRuntimeLogGroup: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error).toMatchObject({
      source: "user",
      meta: {
        agent: RUNTIME_ID,
        logGroupName: RUNTIME_LOG_GROUP,
      },
    });
    expect((error as Error).cause).toBeInstanceOf(ResourceNotFoundException);
  });

  test.each(["Failed", "Cancelled", "Timeout"] as const)(
    "reports CloudWatch query status %s as CloudWatchQueryError",
    async (status) => {
      const error = await runWithRealCore({ status }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudWatchQueryError);
      expect(error).toMatchObject({
        source: "service",
        meta: { status },
      });
    },
  );

  test("warns once when malformed telemetry records are skipped", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (...messages) => warnings.push(messages.join(" ")),
      error: () => {},
      child: () => logger,
    };
    const rows = [
      telemetryRow(
        "session-1",
        JSON.stringify({ kind: "SERVER", traceId: "trace-1", spanId: "span-1" }),
      ),
      telemetryRow("session-1", "{"),
      telemetryRow("session-1", "not-json"),
    ];

    await runWithRealCore({ malformedRows: rows }, logger);

    expect(warnings).toEqual(["skipping malformed telemetry records"]);
  });
});
