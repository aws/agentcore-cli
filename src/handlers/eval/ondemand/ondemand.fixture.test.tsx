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

// Record with: RECORD=1 bun test src/handlers/eval/ondemand/ondemand.fixture.test.tsx
//
// This exercises the real seam end to end: parsing → handler → CoreClient →
// getTracesForAgent (GetAgentRuntime + CloudWatch Logs Insights StartQuery /
// GetQueryResults, read from aws/spans and the runtime group) → evaluate (the
// Evaluate data-plane API) → rendered scores.
//
// Determinism: the window is PINNED (not --lookback-days) so the StartQuery input —
// which embeds startTime/endTime epoch seconds — hashes to the same fixture on
// record and replay. --session-ids bounds the fetch to the two sessions recorded
// against the live agent below.
//
// Re-recording needs the agent to still exist AND those sessions' spans to still be
// within CloudWatch retention (they age out). If they've aged out, invoke the agent
// to create fresh sessions, then repoint FIXTURE_SESSION_IDS + the window at them.
const FIXTURE_AGENT = "asdf_MyAgent-3s5axvBC6Q";
const FIXTURE_SESSION_IDS = [
  "67ebf93b-65e3-4127-9e13-483b239f256a",
  "7f983b9f-9569-4a4d-bdc2-5c997ff346dd",
];
const WINDOW_START = "2026-08-12T00:00:00Z";
const WINDOW_END = "2026-08-13T00:00:00Z";

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

describe("eval ondemand evaluate (fixture-backed)", () => {
  test("evaluates the target sessions client-side and prints scores", async () => {
    const stdout = await run([
      "eval",
      "ondemand",
      "evaluate",
      "--agent",
      FIXTURE_AGENT,
      "--session-ids",
      ...FIXTURE_SESSION_IDS,
      "--start-time",
      WINDOW_START,
      "--end-time",
      WINDOW_END,
      "--evaluator",
      "Builtin.Helpfulness",
    ]);

    matchGolden(FIXTURES, "evaluate.golden.json", stdout);
    const result = JSON.parse(stdout);
    expect(result.sessionsEvaluated).toBeGreaterThan(0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].evaluatorId).toBe("Builtin.Helpfulness");
    // Recording polls live CloudWatch Insights (1s between polls) and calls Evaluate
    // per session, so it needs well over bun's 5s default; replay is instant.
  }, 180_000);
});
