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

// Record with: RECORD=1 bun test src/handlers/eval/ab-test/ab-test.fixture.test.tsx
//
// A/B tests are READ-ONLY here, so — like the batch-evaluation fixture suite —
// this pins pre-existing tests in the fixture account rather than creating one.
// Re-recording requires these ids to still exist; repoint them if they age out.
//
// Exercises the real seam end to end: parsing → handler → CoreClient →
// GetABTest / ListABTest (data plane). GetABTest returns the per-evaluator
// statistical results inline, so there is no CloudWatch seam to record.
const FIXTURE_ABTEST_ID = "abvfylatest_abtargettest-a5f5674e07";

// A well-formed but absent id, to reach the not-found path.
const MISSING_ABTEST_ID = "missing-abtest-0000000000";

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
  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

describe("eval ab-test (fixture-backed)", () => {
  test("get returns the test with per-evaluator metrics inline", async () => {
    const stdout = await run(["eval", "ab-test", "get", "--id", FIXTURE_ABTEST_ID, "--json"]);

    matchGolden(FIXTURES, "get.golden.json", stdout);
    const detail = JSON.parse(stdout);
    expect(detail.abTestId).toBe(FIXTURE_ABTEST_ID);
    expect(detail.status).toBeTruthy();
    expect(detail.executionStatus).toBeTruthy();
    expect(Array.isArray(detail.results.evaluatorMetrics)).toBe(true);
  });

  test("list returns the service page", async () => {
    const stdout = await run(["eval", "ab-test", "list", "--max-results", "3", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(Array.isArray(JSON.parse(stdout).abTests)).toBe(true);
  });

  test("get surfaces a not-found error for an absent test", async () => {
    await expect(
      run(["eval", "ab-test", "get", "--id", MISSING_ABTEST_ID, "--json"]),
    ).rejects.toThrow();
  });
});
