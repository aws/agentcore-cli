import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Record with: RECORD=1 bun test src/handlers/eval/batch-evaluation/batch-evaluation.fixture.test.tsx
//
// Batch evaluation is READ-ONLY, so — unlike the evaluator/online-eval fixture
// suites, which create-then-delete their resource during a record run — this
// pins a pre-existing COMPLETED job in the fixture account. Re-recording requires
// that job to still exist AND its CloudWatch result stream to still hold events
// (streams age out under log retention). If it has aged out, run a fresh batch
// evaluation, wait for it to complete, and repoint FIXTURE_JOB_ID at it before
// re-recording.
//
// This suite exercises the real seam end to end: parsing → handler → CoreClient →
// GetBatchEvaluation (data plane) → readEvaluationResults → GetLogEvents (the
// createLogsClient fixture seam). The TestCoreClient suite (batch-evaluation.test.tsx)
// covers the edges that can't be recorded on demand: a non-terminal job, a
// CloudWatch read failure, and list pagination.
const FIXTURE_JOB_ID = "GTProbe2_1786034545579-8ffefc851e";

// A well-formed but absent id, to reach the not-found path without a
// ValidationException short-circuiting the lookup.
const MISSING_JOB_ID = "missing-batch-eval-0000000000";

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
});
