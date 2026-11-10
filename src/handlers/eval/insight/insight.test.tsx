import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import { InputValidationError } from "../../../errors";
import {
  createSilentLogger,
  expectError,
  fixtureFactories,
  matchGolden,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Recording needs Insights to exist. These came from a Builtin.FailureAnalysis
// batch evaluation over the insights test agent's failure scenarios; regenerate
// them the same way and update the three constants.
const APPLICATION = "InsightsTestAgent_DO_NOT_DELETE.DEFAULT";
const BATCH_EVALUATION_ID = "insights_cli_fixture_fa3-73a1c1cb4b";
const INSIGHT_ID = "ba72cefe89f01b27005b835835e12b36c";

function createFixtureCore(): CoreClient {
  return new CoreClient({ ...fixtureFactories(FIXTURES), logger: createSilentLogger() });
}

async function run(args: string[], core: CoreClient | TestCoreClient = createFixtureCore()) {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "eval", "insight", ...args, "--region", REGION]);
  return io;
}

describe("eval insight command hierarchy", () => {
  test("registers list, get and update", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const insight = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "insight");
    expect(insight?.children().map((c) => c.name())).toEqual(["list", "get", "update"]);
  });

  test("prints help for a bare `eval insight` without an SDK call", async () => {
    const core = new TestCoreClient();
    const io = await run([], core);
    expect(io.stdout()).toContain("Usage: agentcore eval insight");
    expect(core.eval.calls).toEqual([]);
  });
});

describe("eval insight", () => {
  test("lists an application's Insights", async () => {
    const io = await run(["list", "--application-name", APPLICATION, "--max-results", "3"]);
    matchGolden(FIXTURES, "list-application.golden.json", io.stdout());
  });

  test("lists the Insights a batch evaluation produced", async () => {
    const io = await run([
      "list",
      "--batch-evaluation-id",
      BATCH_EVALUATION_ID,
      "--max-results",
      "3",
    ]);
    matchGolden(FIXTURES, "list-batch.golden.json", io.stdout());
  });

  test("gets an Insight with its root causes", async () => {
    const io = await run(["get", "--application-name", APPLICATION, "--id", INSIGHT_ID]);
    expect(JSON.parse(io.stdout()).rootCauses.length).toBeGreaterThan(0);
    matchGolden(FIXTURES, "get.golden.json", io.stdout());
  });

  test("archives an Insight and restores it", async () => {
    const target = ["--application-name", APPLICATION, "--id", INSIGHT_ID];
    const archived = await run(["update", ...target, "--archive-status", "ARCHIVED"]);
    matchGolden(FIXTURES, "update-archived.golden.json", archived.stdout());
    const restored = await run(["update", ...target, "--archive-status", "ACTIVE"]);
    matchGolden(FIXTURES, "update-active.golden.json", restored.stdout());
  });
});

describe("eval insight flag rules", () => {
  test("list sends no filter the user did not pass", async () => {
    const core = new TestCoreClient();
    await run(["list", "--application-name", APPLICATION], core);
    expect(core.eval.calls[0]?.args[0]).toEqual({
      applicationName: APPLICATION,
      batchEvaluationId: undefined,
      nextToken: undefined,
      maxResults: undefined,
    });
  });

  test.each<[string, string[], string]>([
    ["get without --application-name", ["get", "--id", INSIGHT_ID], "--application-name"],
    ["get without --id", ["get", "--application-name", APPLICATION], "--id"],
    [
      "update without --archive-status",
      ["update", "--application-name", APPLICATION, "--id", INSIGHT_ID],
      "--archive-status",
    ],
    [
      "update with an unknown archive status",
      [
        "update",
        "--application-name",
        APPLICATION,
        "--id",
        INSIGHT_ID,
        "--archive-status",
        "DELETED",
      ],
      "--archive-status",
    ],
  ])("rejects %s before any AWS call", async (_, args, message) => {
    const core = new TestCoreClient();
    await expectError(run(args, core), message, InputValidationError);
    expect(core.eval.calls).toEqual([]);
  });
});
