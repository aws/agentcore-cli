import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  testIO,
  TestGlobalConfigAccessor,
} from "../../../../testing";
import type { InvokeDatasetResult } from "../../types";

// Two invoked sessions; the handler feeds these into startBatchEvaluation and renders
// the job it returns (DEFAULT_START_BATCH_EVAL_RESPONSE: batch-eval-test / RUNNING).
const INVOKE_RESULT: InvokeDatasetResult = {
  sessions: [
    { exampleId: "e1", sessionId: "s1", groundTruth: { assertions: [{ text: "polite" }] } },
    { exampleId: "e2", sessionId: "s2" },
  ],
  invoked: 2,
  failed: 0,
  failures: [],
};

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  core.eval.setInvokeDatasetResponse(INVOKE_RESULT);
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout() };
}

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

describe("eval batch-evaluation simulate", () => {
  test("registered under batch-evaluation", () => {
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
    expect(group?.children().map((c) => c.name())).toContain("simulate");
  });

  test.each([
    [
      [
        "--payload-template",
        '{"prompt":"{input}"}',
        "--dataset",
        "/tmp/ds.jsonl",
        "--evaluator",
        "E",
        "--name",
        "n",
      ],
      /--runtime-id/,
    ],
    [
      ["--runtime-id", "r-1", "--dataset", "/tmp/ds.jsonl", "--evaluator", "E", "--name", "n"],
      /--payload-template/,
    ],
    [
      ["--runtime-id", "r-1", "--payload-template", "{}", "--evaluator", "E", "--name", "n"],
      /--dataset/,
    ],
    [
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
      /--evaluator/,
    ],
    [
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
      /--name/,
    ],
  ])("rejects missing required flag", async (args, expected) => {
    await expect(run(["eval", "batch-evaluation", "simulate", ...args])).rejects.toThrow(expected);
  });

  test("composes startBatchEvaluation over the created sessions + wrapped ground truth", async () => {
    const { core, stdout } = await run(BASE);

    expect(JSON.parse(stdout)).toEqual({
      batchEvaluationId: "batch-eval-test",
      status: "RUNNING",
      examplesInvoked: 2,
      examplesFailed: 0,
      sessions: [
        { exampleId: "e1", sessionId: "s1" },
        { exampleId: "e2", sessionId: "s2" },
      ],
    });

    const start = core.eval.calls.find((c) => c.method === "startBatchEvaluation");
    expect(start?.args[0]).toMatchObject({
      name: "sim-1",
      evaluatorIds: ["Builtin.Helpfulness"],
      source: { origin: "agent", agent: "r-1", sessionIds: ["s1", "s2"] },
      // e1's inline GT is wrapped; e2 (no GT) omits the member.
      groundTruth: [
        {
          sessionId: "s1",
          testScenarioId: "e1",
          groundTruth: { inline: { assertions: [{ text: "polite" }] } },
        },
        { sessionId: "s2", testScenarioId: "e2" },
      ],
    });

    // Handler threads the Ctrl-C AbortSignal into the replay (invokeDataset) call.
    const invoke = core.eval.calls.find((c) => c.method === "invokeDataset");
    expect(invoke?.args[2]).toBeInstanceOf(AbortSignal);
  });

  // Golden: the exact evaluationMetadata (sessionMetadata) the handler builds from the
  // invoked sessions. Locks the `{ inline: gt }` wrapping and the omitted-member case for
  // a session with no ground truth — the wire shape the batch service reads.
  test("builds the sessionMetadata ground-truth shape [golden]", async () => {
    const { core } = await run(BASE);
    const start = core.eval.calls.find((c) => c.method === "startBatchEvaluation");
    const input = start!.args[0] as { groundTruth: unknown };
    expect(input.groundTruth).toMatchSnapshot();
  });

  test("refuses to grade when nothing was invoked, naming the first failure", async () => {
    await expect(
      run(BASE, (core) =>
        core.eval.setInvokeDatasetResponse({
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
