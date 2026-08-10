import { test, expect, describe } from "bun:test";
import type {
  GetBatchEvaluationResponse,
  ListBatchEvaluationsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/";
import type { BatchEvaluationResultEntry, StartBatchEvaluationInput } from "../types";

// Command-flow tests for `eval batch-evaluation`, driven through the real root
// handler against a TestCoreClient (no network). These cover the edges that the
// fixture-backed suite (batch-evaluation.fixture.test.tsx) can't record on demand:
// a non-terminal job, a CloudWatch read failure, and list pagination. The
// happy-path get (with real merged results) and --disable-cw-results live there.

const CW = {
  outputConfig: { cloudWatchConfig: { logGroupName: "lg", logStreamName: "ls" } },
} as const;

const COMPLETED: GetBatchEvaluationResponse = {
  batchEvaluationId: "batch-eval-abc123",
  status: "COMPLETED",
  ...CW,
} as GetBatchEvaluationResponse;

const RUNNING: GetBatchEvaluationResponse = {
  batchEvaluationId: "batch-eval-run",
  status: "IN_PROGRESS",
  ...CW,
} as GetBatchEvaluationResponse;

const RESULTS: BatchEvaluationResultEntry[] = [
  { evaluatorId: "Builtin.Helpfulness", level: "Session", sessionId: "s1", score: 5 },
];

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
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

describe("eval batch-evaluation command hierarchy", () => {
  test("registers get + list under eval → batch-evaluation", () => {
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
      .find((c) => c.name() === "batch-evaluation");
    expect(group?.children().map((c) => c.name())).toEqual(["evaluate", "get", "list"]);
  });

  test("prints help for `eval batch-evaluation --json` without an SDK call", async () => {
    // Under --json the empty-invocation TUI middleware (inherited from the eval
    // parent) prints help instead of opening the interactive UI.
    const { core, stdout } = await run(["eval", "batch-evaluation", "--json"]);
    expect(stdout).toContain("Usage: agentcore eval batch-evaluation");
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("eval batch-evaluation evaluate", () => {
  test("requires --name and --evaluator", async () => {
    await expect(
      run(["eval", "batch-evaluation", "evaluate", "--agent", "a", "--json"]),
    ).rejects.toThrow(/--name/);
    await expect(
      run(["eval", "batch-evaluation", "evaluate", "--name", "n", "--json"]),
    ).rejects.toThrow(/--evaluator/);
  });

  test("rejects zero or multiple source arms", async () => {
    await expect(
      run([
        "eval",
        "batch-evaluation",
        "evaluate",
        "--name",
        "n",
        "--evaluator",
        "Builtin.Helpfulness",
        "--json",
      ]),
    ).rejects.toThrow(/exactly one source/);
    await expect(
      run([
        "eval",
        "batch-evaluation",
        "evaluate",
        "--name",
        "n",
        "--evaluator",
        "Builtin.Helpfulness",
        "--agent",
        "a",
        "--online-eval",
        "oe",
        "--json",
      ]),
    ).rejects.toThrow(/exactly one source/);
  });

  test("passes the resolved agent source + evaluators to Core", async () => {
    const { core, stdout } = await run([
      "eval",
      "batch-evaluation",
      "evaluate",
      "--name",
      "job1",
      "--agent",
      "orders-agent",
      "--endpoint",
      "prod",
      "--evaluator",
      "Builtin.Helpfulness",
      "Builtin.Correctness",
      "--start-time",
      "2026-01-01T00:00:00Z",
      "--end-time",
      "2026-01-08T00:00:00Z",
      "--json",
    ]);
    expect(JSON.parse(stdout).batchEvaluationId).toBe("batch-eval-test");
    const call = core.eval.calls.find((c) => c.method === "startBatchEvaluation");
    expect(call).toBeDefined();
    const input = call!.args[0] as StartBatchEvaluationInput;
    expect(input.name).toBe("job1");
    expect(input.evaluatorIds).toEqual(["Builtin.Helpfulness", "Builtin.Correctness"]);
    expect(input.source).toEqual({
      origin: "agent",
      agent: "orders-agent",
      endpoint: "prod",
      window: {
        startTime: new Date("2026-01-01T00:00:00Z"),
        endTime: new Date("2026-01-08T00:00:00Z"),
      },
      sessionIds: undefined,
    });
  });

  test("resolves the online-eval source arm", async () => {
    const { core } = await run([
      "eval",
      "batch-evaluation",
      "evaluate",
      "--name",
      "job2",
      "--online-eval",
      "oe-1",
      "--evaluator",
      "Builtin.Helpfulness",
      "--json",
    ]);
    const call = core.eval.calls.find((c) => c.method === "startBatchEvaluation");
    const input = call!.args[0] as StartBatchEvaluationInput;
    expect(input.source).toEqual({
      origin: "online-eval",
      onlineEvaluationConfigId: "oe-1",
      window: undefined,
    });
  });

  test("rejects --session-ids on the online-eval arm", async () => {
    await expect(
      run([
        "eval",
        "batch-evaluation",
        "evaluate",
        "--name",
        "n",
        "--evaluator",
        "Builtin.Helpfulness",
        "--online-eval",
        "oe",
        "--session-ids",
        "s1",
        "--json",
      ]),
    ).rejects.toThrow(/session-ids/);
  });
});

describe("eval batch-evaluation get", () => {
  test("requires --id", async () => {
    await expect(run(["eval", "batch-evaluation", "get", "--json"])).rejects.toThrow(/--id/);
  });

  test("includes CloudWatch results for a terminal job by default", async () => {
    const { core, stdout } = await run(
      ["eval", "batch-evaluation", "get", "--id", "batch-eval-abc123", "--json"],
      (c) => {
        c.eval.setBatchEvalGetResponse(COMPLETED);
        c.eval.setBatchEvalResults(RESULTS);
      },
    );
    const out = JSON.parse(stdout);
    expect(out.status).toBe("COMPLETED");
    expect(out.results).toEqual(RESULTS);
    // A single Core call; the CloudWatch merge happens inside it. Results were
    // requested by default.
    const call = core.eval.calls.find((c) => c.method === "getBatchEvaluation");
    expect(call?.args[2]).toEqual({ includeResults: true });
  });

  test("passes includeResults:false to Core for --disable-cw-results", async () => {
    // The happy-path output shape is asserted in the fixture-backed suite; here we
    // only pin that the flag reaches Core as includeResults:false.
    const { core } = await run(
      [
        "eval",
        "batch-evaluation",
        "get",
        "--id",
        "batch-eval-abc123",
        "--disable-cw-results",
        "--json",
      ],
      (c) => c.eval.setBatchEvalGetResponse(COMPLETED),
    );
    const call = core.eval.calls.find((c) => c.method === "getBatchEvaluation");
    expect(call?.args[2]).toEqual({ includeResults: false });
  });

  test("omits results for a non-terminal job", async () => {
    const { core, stdout } = await run(
      ["eval", "batch-evaluation", "get", "--id", "batch-eval-run", "--json"],
      (c) => c.eval.setBatchEvalGetResponse(RUNNING),
    );
    expect(JSON.parse(stdout).results).toBeUndefined();
    expect(core.eval.calls.map((c) => c.method)).toEqual(["getBatchEvaluation"]);
  });

  test("a CloudWatch failure warns on stderr but never hides job status", async () => {
    const { stdout, stderr } = await run(
      ["eval", "batch-evaluation", "get", "--id", "batch-eval-abc123", "--json"],
      (c) => {
        c.eval.setBatchEvalGetResponse(COMPLETED);
        // Core returns the metadata plus `resultsError` (a CloudWatch read
        // failure), never throwing — so status must survive.
        c.eval.setBatchEvalResultsError(new Error("AccessDenied"));
      },
    );
    const out = JSON.parse(stdout);
    expect(out.status).toBe("COMPLETED"); // status intact
    expect(out.results).toBeUndefined();
    expect(stderr).toContain("could not retrieve CloudWatch results");
    expect(stderr).toContain("AccessDenied");
  });
});

describe("eval batch-evaluation list", () => {
  const PAGE: ListBatchEvaluationsResponse = {
    batchEvaluations: [
      { batchEvaluationId: "b1", status: "COMPLETED" },
      { batchEvaluationId: "b2", status: "FAILED" },
    ],
    nextToken: "next",
  } as ListBatchEvaluationsResponse;

  test("passes pagination through and returns the page verbatim", async () => {
    const { core, stdout } = await run(
      ["eval", "batch-evaluation", "list", "--max-results", "10", "--json"],
      (c) => c.eval.setBatchEvalListResponse(PAGE),
    );
    const out = JSON.parse(stdout);
    expect(out.batchEvaluations).toHaveLength(2);
    expect(out.nextToken).toBe("next");
    expect(core.eval.calls[0]?.args).toEqual([undefined, 10, { region: "us-west-2" }]);
  });
});
