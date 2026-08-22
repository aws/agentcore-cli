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

// Record with RECORD=1 bun test src/handlers/eval/online-insight/online-insight.test.tsx
// The RECORD run creates one online insight config against a real runtime,
// exercises list/get/resume/pause against it, then deletes it, so a recording
// leaves no residue. The id the service assigns is captured from the recorded
// create response, which keeps the dependent fixtures (keyed by request input)
// stable on replay.
const CONFIG_NAME = "agentcore_cli_online_insight_fixture";

// online-insight requires an insight id (no evaluators); a builtin needs no setup.
const FIXTURE_INSIGHT_ID = "Builtin.Insight.FailureAnalysis";

// The runtime whose traffic the recorded config samples. `--agent` resolves it to
// the CloudWatch log group / service name pair, so the id must exist in the
// fixture account. It is only referenced, never invoked.
const FIXTURE_AGENT_ID = "testAgent_Agent-wm9hYBD93Y";

// online-insight has no auto-provisioning, so --role-arn is required. This role
// pre-exists in the fixture account, scoped to online-evaluation-config/*.
const FIXTURE_ROLE_ARN = "arn:aws:iam::725476964917:role/AgentCoreEvalsSDK-us-west-2-a6864eb339";

// Well-formed but absent id: it passes the id pattern so the request reaches the
// service and comes back not-found, rather than failing local validation first.
const MISSING_CONFIG_ID = "missing-online-0000000000";

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

// The id assigned by CreateOnlineEvaluationConfig, shared by the tests below.
let configId: string;

describe("eval online-insight command hierarchy", () => {
  test("registers the eval → online-insight command tree", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const onlineInsight = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "online-insight");

    expect(onlineInsight?.children().map((c) => c.name())).toEqual([
      "create",
      "get",
      "list",
      "pause",
      "resume",
      "delete",
    ]);
  });
});

describe("online-insight CRUDL", () => {
  test("creates an online insight config from an agent", async () => {
    const stdout = await run([
      "eval",
      "online-insight",
      "create",
      "--name",
      CONFIG_NAME,
      "--agent",
      FIXTURE_AGENT_ID,
      "--role-arn",
      FIXTURE_ROLE_ARN,
      "--insight",
      FIXTURE_INSIGHT_ID,
      "--sampling-rate",
      "10",
      "--enable-on-create",
      "false",
    ]);

    matchGolden(FIXTURES, "create.golden.json", stdout);
    configId = JSON.parse(stdout).onlineEvaluationConfigId;
    expect(configId).toBeString();
  });

  test("lists online insight configs", async () => {
    // --json forces the headless path; a bare `list` (no flags) would otherwise
    // open the TUI under the empty-invocation middleware.
    const stdout = await run(["eval", "online-insight", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).onlineEvaluationConfigs).toBeArray();
  });

  test("paginates the list with --max-results and --next-token", async () => {
    const firstPage = await run(["eval", "online-insight", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.onlineEvaluationConfigs).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "eval",
      "online-insight",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).onlineEvaluationConfigs).toHaveLength(1);
  });

  test("gets the config, exposing the insight, no evaluators, and the custom role", async () => {
    const stdout = await run(["eval", "online-insight", "get", "--id", configId]);
    matchGolden(FIXTURES, "get.golden.json", stdout);

    const detail = JSON.parse(stdout);
    expect(detail.onlineEvaluationConfigName).toBe(CONFIG_NAME);
    expect(detail.insights.map((i: { insightId: string }) => i.insightId)).toContain(
      FIXTURE_INSIGHT_ID,
    );
    // create passed --insight, never --evaluator, so the evaluator list stays empty.
    expect(detail.evaluators ?? []).toEqual([]);
    // --role-arn is used verbatim; online-insight never provisions a role.
    expect(detail.evaluationExecutionRoleArn).toBe(FIXTURE_ROLE_ARN);
  });

  // resume and pause are asserted in one test because the service rejects an
  // update while the previous one is still settling (ConflictException, state
  // UPDATING). Recording therefore waits for the config to leave UPDATING between
  // the two calls; on replay the fixtures are served instantly and the wait is a
  // no-op, so the test stays fast and deterministic.
  test("resumes then pauses the config, toggling execution status", async () => {
    const resumeStdout = await run(["eval", "online-insight", "resume", "--id", configId]);
    matchGolden(FIXTURES, "resume.golden.json", resumeStdout);
    expect(JSON.parse(resumeStdout).executionStatus).toBe("ENABLED");

    await settle();

    const pauseStdout = await run(["eval", "online-insight", "pause", "--id", configId]);
    matchGolden(FIXTURES, "pause.golden.json", pauseStdout);
    expect(JSON.parse(pauseStdout).executionStatus).toBe("DISABLED");
    // Extended timeout so the settle() wait fits while recording; it is a no-op on replay.
  }, 60_000);

  test("deletes the online insight config", async () => {
    const stdout = await run(["eval", "online-insight", "delete", "--id", configId]);
    matchGolden(FIXTURES, "delete.golden.json", stdout);
  });

  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["eval", "online-insight", "get", "--id", MISSING_CONFIG_ID]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});

// Flag parsing never reaches the SDK, so these need no fixtures.
describe("flag validation", () => {
  test("create requires --role-arn", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--insight",
        FIXTURE_INSIGHT_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow("required option '--role-arn <role-arn>' not specified");
  });

  test("create requires --insight", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow("required option '--insight <insight...>' not specified");
  });

  test("create rejects an insight id that is neither a builtin nor an ARN", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--insight",
        "nope",
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/invalid insight "nope"/);
  });

  test("create requires exactly one of --agent or --data-source-config", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--insight",
        FIXTURE_INSIGHT_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/exactly one of '--agent' or '--data-source-config'/);
  });

  test("create rejects both --agent and --data-source-config", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--insight",
        FIXTURE_INSIGHT_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/exactly one of '--agent' or '--data-source-config'/);
  });

  test("create rejects --endpoint without --agent", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
        "--endpoint",
        "prod",
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--insight",
        FIXTURE_INSIGHT_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/'--endpoint' can only be used with '--agent'/);
  });

  test("create rejects malformed --data-source-config JSON", async () => {
    await expect(
      run([
        "eval",
        "online-insight",
        "create",
        "--name",
        CONFIG_NAME,
        "--data-source-config",
        "not-json",
        "--role-arn",
        FIXTURE_ROLE_ARN,
        "--insight",
        FIXTURE_INSIGHT_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--data-source-config'/);
  });

  // --json forces the headless path so the required-flag error surfaces; without
  // it a bare invocation opens the TUI under the empty-invocation middleware.
  test.each(["get", "pause", "resume", "delete"])("%s requires --id", async (command) => {
    await expect(run(["eval", "online-insight", command, "--json"])).rejects.toThrow(
      /required option '--id <id>' not specified/,
    );
  });
});
