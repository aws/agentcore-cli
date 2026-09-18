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

// Record with: RECORD=1 bun test src/handlers/eval/batch-evaluation/batch-evaluation.fixture.test.tsx
//
// The read tests pin a pre-existing COMPLETED job in the fixture account.
// Re-recording requires that job to still exist AND its CloudWatch result stream
// to still hold events (streams age out under log retention). If it has aged
// out, run a fresh batch evaluation, wait for it to complete, and repoint
// FIXTURE_JOB_ID at it before re-recording. The stop test creates its own job and
// immediately transitions it to a terminal state.
//
// This suite exercises the real seam end to end: parsing → handler → CoreClient →
// GetBatchEvaluation (data plane) → CloudWatchClient.readLogStream →
// readEvaluationResults → GetLogEvents (the createLogsClient fixture seam). The
// TestCoreClient suite (batch-evaluation.test.tsx) covers the edges that can't be
// recorded on demand: a non-terminal job, a CloudWatch read failure, and list
// pagination.
const FIXTURE_JOB_ID = "GTProbe2_1786034545579-8ffefc851e";

// A well-formed but absent id, to reach the not-found path without a
// ValidationException short-circuiting the lookup.
const MISSING_JOB_ID = "missing-batch-eval-0000000000";

// evaluate is a WRITE: a record run resolves this agent (GetAgentRuntime) and
// submits a real StartBatchEvaluation job that runs to completion — there is no
// undo, same as the get/list fixtures pinning a real job. Re-recording needs the
// agent to still exist and a unique --name (the service rejects a duplicate), so
// bump FIXTURE_EVAL_NAME when re-recording.
const FIXTURE_EVAL_AGENT = "asdf_MyAgent-3s5axvBC6Q";
const FIXTURE_EVAL_NAME = "golden_batch_evaluate_fixture685";
const FIXTURE_STOP_NAME = "golden_batch_stop_fixture_20260917_1";
const FIXTURE_STOP_AGENT = "demoEval_demoAgent-qGEpAAE68u";

const FIXTURE_SIMULATE_NAME = "golden_batch_simulate_fixture1";
const FIXTURE_OUTPUT_CONFIG_NAME = "golden_batch_evaluate_outputconfig1";
const FIXTURE_SIMULATE_ENDPOINT_NAME = "golden_batch_simulate_endpoint1";
const FIXTURE_SIMULATE_DATASET = join(FIXTURES, "simulate-ds.jsonl");

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

// run drives the real router (parsing → middleware → handler → CoreClient) against
// the fixture-backed SDK clients and returns captured stdout.
async function run(args: string[]): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("eval batch-evaluation (fixture-backed)", () => {
  test("get returns the job with CloudWatch-backed results by default", async () => {
    // Records GetBatchEvaluationCommand.<hash>.json (data plane) AND
    // GetLogEventsCommand.<hash>.json (the CloudWatch logs seam).
    const stdout = await run(["eval", "batch-evaluation", "get", "--id", FIXTURE_JOB_ID, "--json"]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    const detail = JSON.parse(stdout);
    expect(detail.status).toBe("COMPLETED");
    expect(Array.isArray(detail.results)).toBe(true);
    expect(detail.results.length).toBeGreaterThan(0);
    // Results carry the scope the old parser dropped.
    expect(detail.results[0]).toHaveProperty("level");
    expect(detail.results[0]).toHaveProperty("sessionId");
  });

  test("get --disable-cw-results returns metadata only, no CloudWatch read", async () => {
    // Same job, includeResults:false → a distinct GetBatchEvaluation input hash
    // (its own fixture) and no GetLogEvents call.
    const stdout = await run([
      "eval",
      "batch-evaluation",
      "get",
      "--id",
      FIXTURE_JOB_ID,
      "--disable-cw-results",
      "--json",
    ]);

    matchGolden(FIXTURES, "get-disable-cw.golden.json", stdout);
    const detail = JSON.parse(stdout);
    expect(detail.status).toBe("COMPLETED");
    expect(detail.results).toBeUndefined();
  });

  test("list returns the service page", async () => {
    const stdout = await run(["eval", "batch-evaluation", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(Array.isArray(JSON.parse(stdout).batchEvaluations)).toBe(true);
  });

  test("get surfaces a not-found error for an absent job", async () => {
    await expect(
      run(["eval", "batch-evaluation", "get", "--id", MISSING_JOB_ID, "--json"]),
    ).rejects.toThrow();
  });

  test("evaluate submits a job for the --agent source", async () => {
    // Records GetAgentRuntimeCommand.<hash>.json (agent → runtime resolution) AND
    // StartBatchEvaluationCommand.<hash>.json (the submitted job).
    const stdout = await run([
      "eval",
      "batch-evaluation",
      "evaluate",
      "--agent",
      FIXTURE_EVAL_AGENT,
      "--evaluators",
      "Builtin.Helpfulness",
      "--name",
      FIXTURE_EVAL_NAME,
      "--json",
    ]);

    matchGolden(FIXTURES, "evaluate.golden.json", stdout);
    const job = JSON.parse(stdout);
    expect(job.batchEvaluationId).toBeTruthy();
    expect(job.status).toBeTruthy();
  });

  test("stop transitions a running batch evaluation", async () => {
    const started = JSON.parse(
      await run([
        "eval",
        "batch-evaluation",
        "evaluate",
        "--agent",
        FIXTURE_STOP_AGENT,
        "--evaluators",
        "Builtin.Helpfulness",
        "--name",
        FIXTURE_STOP_NAME,
        "--json",
      ]),
    );
    await settle(1_000);

    const stdout = await run([
      "eval",
      "batch-evaluation",
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
    await expect(run(["eval", "batch-evaluation", "stop", "--json"])).rejects.toThrow(/--id/);
  });

  test("simulate replays a dataset, then submits a batch job over the created sessions", async () => {
    let n = 0;
    const { createControlClient, createDataClient, createIamClient, createLogsClient } =
      fixtureFactories(FIXTURES);
    const core = new CoreClient({
      createControlClient,
      createDataClient,
      createIamClient,
      createLogsClient,
      logger: createSilentLogger(),
      newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
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
      "batch-evaluation",
      "simulate",
      "--runtime-id",
      FIXTURE_EVAL_AGENT,
      "--payload-template",
      '{"prompt":"{input}"}',
      "--dataset",
      FIXTURE_SIMULATE_DATASET,
      "--evaluators",
      "Builtin.Helpfulness",
      "--name",
      FIXTURE_SIMULATE_NAME,
      "--ingestion-wait-ms",
      "0",
      "--json",
      "--region",
      REGION,
    ]);

    matchGolden(FIXTURES, "simulate.golden.json", io.stdout());
  }, 180_000);

  test("evaluate submits a job with a customer-supplied output config", async () => {
    // The StartBatchEvaluation fixture is keyed by the full SDK request, so this
    // also verifies that raw prefix selectors and session trace filters pass
    // through the command handler unchanged.
    const stdout = await run([
      "eval",
      "batch-evaluation",
      "evaluate",
      "--data-source-config",
      '{"cloudWatchLogs":{"logGroupNamePrefixes":["/aws/bedrock-agentcore/runtimes/support_agent-"],"serviceNames":["support_agent.DEFAULT"],"filterConfig":{"sessionTraceIds":[{"sessionId":"session-123","traceIds":["4bf92f3577b34da6a3ce929d0e0e4736"]}]}}}',
      "--evaluators",
      "Builtin.Helpfulness",
      "--name",
      FIXTURE_OUTPUT_CONFIG_NAME,
      "--output-config",
      '{"cloudWatchConfig":{"resultDestination":"SOURCE_LOG_GROUP","metricsNamespace":"Company/AgentEvaluations"}}',
      "--json",
    ]);

    matchGolden(FIXTURES, "evaluate-output-config.golden.json", stdout);
  });

  test("simulate passes --endpoint through and submits with an output config", async () => {
    let n = 0;
    const { createControlClient, createDataClient, createIamClient, createLogsClient } =
      fixtureFactories(FIXTURES);
    const core = new CoreClient({
      createControlClient,
      createDataClient,
      createIamClient,
      createLogsClient,
      logger: createSilentLogger(),
      newSessionId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
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
      "batch-evaluation",
      "simulate",
      "--runtime-id",
      FIXTURE_EVAL_AGENT,
      "--endpoint",
      "DEFAULT",
      "--payload-template",
      '{"prompt":"{input}"}',
      "--dataset",
      FIXTURE_SIMULATE_DATASET,
      "--evaluators",
      "Builtin.Helpfulness",
      "--name",
      FIXTURE_SIMULATE_ENDPOINT_NAME,
      "--output-config",
      '{"cloudWatchConfig":{"resultDestination":"SOURCE_LOG_GROUP"}}',
      "--ingestion-wait-ms",
      "0",
      "--json",
      "--region",
      REGION,
    ]);

    matchGolden(FIXTURES, "simulate-endpoint-output-config.golden.json", io.stdout());
  }, 180_000);
});
