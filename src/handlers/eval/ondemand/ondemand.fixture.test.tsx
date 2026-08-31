import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
  uniquePerRecording,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

const FIXTURE_AGENT = "asdf_MyAgent-3s5axvBC6Q";
const SIMULATE_DATASET = join(FIXTURES, "simulate-ds.jsonl");
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

  test("simulate replays a dataset, then evaluates the created sessions client-side", async () => {
    const nonce = uniquePerRecording(FIXTURES, "session-nonce", () => Date.now().toString(16));
    const windowNow = uniquePerRecording(
      FIXTURES,
      "trace-window-now",
      () => Date.now() + 24 * 60 * 60 * 1000,
    );
    let n = 0;
    const { createControlClient, createDataClient, createIamClient, createLogsClient } =
      fixtureFactories(FIXTURES);
    const core = new CoreClient({
      createControlClient,
      createDataClient,
      createIamClient,
      createLogsClient,
      logger: createSilentLogger(),
      newSessionId: () =>
        `00000000-0000-4000-8000-${nonce.slice(-8).padStart(8, "0")}${String(++n).padStart(4, "0")}`,
      now: () => windowNow,
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
      "ondemand",
      "simulate",
      "--runtime-id",
      FIXTURE_AGENT,
      "--payload-template",
      '{"prompt":"{input}"}',
      "--dataset",
      SIMULATE_DATASET,
      "--evaluator",
      "Builtin.Correctness",
      "--ingestion-wait-ms",
      isRecording() ? "150000" : "0",
      "--region",
      REGION,
    ]);

    matchGolden(FIXTURES, "simulate.golden.json", io.stdout());
  }, 200_000);
});
