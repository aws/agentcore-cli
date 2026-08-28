import { test, expect, describe } from "bun:test";
import type {
  GetBatchEvaluationResponse,
  ListBatchEvaluationsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/";
import type { BatchEvaluationResultEntry } from "../types";

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
    expect(group?.children().map((c) => c.name())).toEqual(["evaluate", "simulate", "get", "list"]);
  });

  test("prints help for `eval batch-evaluation --json` without an SDK call", async () => {
    // Under --json the empty-invocation TUI middleware (inherited from the eval
    // parent) prints help instead of opening the interactive UI.
    const { core, stdout } = await run(["eval", "batch-evaluation", "--json"]);
    expect(stdout).toContain("Usage: agentcore eval batch-evaluation");
    expect(core.eval.calls).toHaveLength(0);
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

describe("eval batch-evaluation simulate", () => {
  const BASE = [
    "eval",
    "batch-evaluation",
    "simulate",
    "--runtime-id",
    "r-1",
    "--payload-template",
    '{"prompt":"{input}"}',
    "--dataset",
    "/tmp/ds.jsonl",
    "--evaluator",
    "Builtin.Helpfulness",
    "--name",
    "sim-1",
  ];

  test.each<[RegExp, string[]]>([
    [
      /--runtime-id/,
      ["--payload-template", "{}", "--dataset", "/tmp/ds.jsonl", "--evaluator", "E", "--name", "n"],
    ],
    [
      /--payload-template/,
      ["--runtime-id", "r-1", "--dataset", "/tmp/ds.jsonl", "--evaluator", "E", "--name", "n"],
    ],
    [
      /--dataset/,
      ["--runtime-id", "r-1", "--payload-template", "{}", "--evaluator", "E", "--name", "n"],
    ],
    [
      /--evaluator/,
      [
        "--runtime-id",
        "r-1",
        "--payload-template",
        "{}",
        "--dataset",
        "/tmp/ds.jsonl",
        "--name",
        "n",
      ],
    ],
    [
      /--name/,
      [
        "--runtime-id",
        "r-1",
        "--payload-template",
        "{}",
        "--dataset",
        "/tmp/ds.jsonl",
        "--evaluator",
        "E",
      ],
    ],
  ])("rejects when a required flag is missing (%s)", async (expected, args) => {
    await expect(run(["eval", "batch-evaluation", "simulate", ...args])).rejects.toThrow(expected);
  });

  test("refuses to grade when nothing was invoked, naming the first failure", async () => {
    await expect(
      run(BASE, (c) =>
        c.eval.setInvokeDatasetResponse({
          sessions: [],
          invoked: 0,
          failed: 3,
          failures: [
            { exampleId: "e1", error: "HTTP 500" },
            { exampleId: "e2", error: "HTTP 500" },
            { exampleId: "e3", error: "HTTP 500" },
          ],
        }),
      ),
    ).rejects.toThrow(/no examples could be invoked \(3 failed\).*first error: e1 — HTTP 500/);
  });

  test("passes --ingestion-wait-ms through to invokeDataset and renders failures", async () => {
    const { core, stdout } = await run([...BASE, "--ingestion-wait-ms", "0"], (c) =>
      c.eval.setInvokeDatasetResponse({
        sessions: [{ exampleId: "ok1", sessionId: "s1" }],
        invoked: 1,
        failed: 1,
        failures: [{ exampleId: "bad", error: "HTTP 500" }],
      }),
    );
    const invoke = core.eval.calls.find((c) => c.method === "invokeDataset");
    expect(invoke).toBeDefined();
    expect((invoke!.args[0] as { waitIngestionMs?: number }).waitIngestionMs).toBe(0);
    expect(JSON.parse(stdout).failures).toEqual([{ exampleId: "bad", error: "HTTP 500" }]);
  });
});
