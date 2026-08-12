import { test, expect, describe } from "bun:test";
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
  results: [{ evaluatorId: "Builtin.Helpfulness", value: 0.9 } as EvaluateResult["results"][number]],
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
  test("requires --agent", async () => {
    await expect(
      run([
        "eval",
        "ondemand",
        "evaluate",
        "--evaluator",
        "Builtin.Helpfulness",
        "--session-ids",
        "s1",
      ]),
    ).rejects.toThrow(/--agent/);
  });

  test("requires --evaluator", async () => {
    await expect(
      run(["eval", "ondemand", "evaluate", "--agent", "a-1", "--session-ids", "s1"]),
    ).rejects.toThrow(/--evaluator/);
  });

  test("rejects an empty session source", async () => {
    await expect(run(BASE)).rejects.toThrow(/session source/);
  });

  test("rejects --lookback-days combined with an explicit window", async () => {
    await expect(
      run([
        ...BASE,
        "--lookback-days",
        "7",
        "--start-time",
        "2026-01-01T00:00:00Z",
        "--end-time",
        "2026-01-02T00:00:00Z",
      ]),
    ).rejects.toThrow(/cannot be combined/);
  });

  test("rejects a half-open explicit window", async () => {
    await expect(run([...BASE, "--start-time", "2026-01-01T00:00:00Z"])).rejects.toThrow(
      /together/,
    );
  });

  test("rejects start-time not before end-time", async () => {
    await expect(
      run([...BASE, "--start-time", "2026-01-02T00:00:00Z", "--end-time", "2026-01-01T00:00:00Z"]),
    ).rejects.toThrow(/before/);
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
