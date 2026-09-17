import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  settle,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const FIXTURE_JOB_ID = "golden_batch_insights_fixture-cd634815b4";
const FIXTURE_NAME = "golden_batch_insights_fixture";
const FIXTURE_STOP_NAME = "golden_batch_insights_stop_fixture_20260917_1";
const FIXTURE_AGENT = "asdf_MyAgent-3s5axvBC6Q";
const FIXTURE_STOP_AGENT = "demoEval_demoAgent-qGEpAAE68u";

// Record with:
// RECORD=1 bun test src/handlers/eval/batch-insights/batch-insights.fixture.test.tsx
//
// `get` pins a pre-existing completed insights job. `run` and `stop` create
// durable service jobs, so use unique fixture names before re-recording. Do not
// repeat record mode with the same names: the recorded conflict replaces the
// successful StartBatchEvaluation fixtures.
function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
  });
}

async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["bun", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("eval batch-insights (fixture-backed)", () => {
  test("get returns the service-side insights job directly", async () => {
    const stdout = await run(["eval", "batch-insights", "get", "--id", FIXTURE_JOB_ID, "--json"]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    const detail = JSON.parse(stdout);
    expect(detail.status).toBe("COMPLETED");
    expect(detail.insights).toEqual([{ insightId: "Builtin.Insight.FailureAnalysis" }]);
    expect(detail.results).toBeUndefined();
  });

  test("list filters evaluator-only jobs from the shared service page", async () => {
    const stdout = await run(["eval", "batch-insights", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    const page = JSON.parse(stdout);
    expect(page.batchEvaluations.length).toBeGreaterThan(0);
    expect(
      page.batchEvaluations.every((job: { insights?: unknown[] }) => job.insights?.length),
    ).toBe(true);
    expect(page.batchEvaluations[0].batchEvaluationId).toBe(FIXTURE_JOB_ID);
  });

  test("run submits an insights batch job", async () => {
    const stdout = await run([
      "eval",
      "batch-insights",
      "run",
      "--name",
      FIXTURE_NAME,
      "--description",
      "Golden batch insights fixture",
      "--agent",
      FIXTURE_AGENT,
      "--json",
    ]);

    matchGolden(FIXTURES, "run.golden.json", stdout);
    const job = JSON.parse(stdout);
    expect(job.batchEvaluationId).toBeTruthy();
    expect(job.insights).toEqual([{ insightId: "Builtin.Insight.FailureAnalysis" }]);
  });

  test("stop transitions a running batch insights job", async () => {
    const started = JSON.parse(
      await run([
        "eval",
        "batch-insights",
        "run",
        "--name",
        FIXTURE_STOP_NAME,
        "--agent",
        FIXTURE_STOP_AGENT,
        "--json",
      ]),
    );
    await settle(1_000);

    const stdout = await run([
      "eval",
      "batch-insights",
      "stop",
      "--id",
      started.batchEvaluationId,
      "--json",
    ]);

    matchGolden(FIXTURES, "stop.golden.json", stdout);
    const stopped = JSON.parse(stdout);
    expect(stopped.batchEvaluationId).toBe(started.batchEvaluationId);
    expect(["STOPPING", "STOPPED"]).toContain(stopped.status);
  }, 180_000);

  test("stop requires --id before making an AWS call", async () => {
    await expect(run(["eval", "batch-insights", "stop", "--json"])).rejects.toThrow(/--id/);
  });
});
