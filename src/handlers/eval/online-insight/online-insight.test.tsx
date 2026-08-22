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

// A plain online-EVAL config (no insights) that pre-exists in the fixture account.
// The insight id-guards GET-verify it, see no insights, and reject before touching
// it — so pointing get/delete at it is a safe negative test that mutates nothing.
const EVAL_ONLY_CONFIG_ID = "ABVfyLatest_ProdEval-2vqlCb2UiG";

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
      "update",
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
      "--session-timeout-minutes",
      "30",
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
    const configs = JSON.parse(stdout).onlineEvaluationConfigs;
    expect(configs).toBeArray();
    // list is insight-only now: the client filters the online-eval list down to
    // configs that carry insights, so every returned row must have a non-empty one.
    expect(configs.length).toBeGreaterThan(0);
    for (const c of configs) expect(c.insights?.length ?? 0).toBeGreaterThan(0);
  });

  // The list now fills each page across the shared API's underlying pages: the
  // client pulls eval-config pages and accumulates insight configs until it has
  // --max-results of them. With several insight configs in the account, a page
  // fills exactly — page-1 holds one insight config and carries a nextToken past
  // it; page-2 holds the next, distinct insight config.
  test("paginates the list with --max-results and --next-token", async () => {
    const firstPage = await run(["eval", "online-insight", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.onlineEvaluationConfigs).toBeArray();
    expect(first.onlineEvaluationConfigs.length).toBe(1);
    for (const c of first.onlineEvaluationConfigs)
      expect(c.insights?.length ?? 0).toBeGreaterThan(0);
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
    const second = JSON.parse(secondPage);
    expect(second.onlineEvaluationConfigs).toBeArray();
    expect(second.onlineEvaluationConfigs.length).toBe(1);
    for (const c of second.onlineEvaluationConfigs)
      expect(c.insights?.length ?? 0).toBeGreaterThan(0);

    // page-2 is the next insight config, not a repeat of page-1's.
    expect(second.onlineEvaluationConfigs[0].onlineEvaluationConfigId).not.toBe(
      first.onlineEvaluationConfigs[0].onlineEvaluationConfigId,
    );
  }, 60_000);

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

  // update runs after resume/pause and folds get in on purpose. Every id-scoped op
  // (get, and the GET-verify guard in update/pause/resume/delete) issues
  // GetOnlineEvaluationConfig with the same id, so they all share one input-keyed
  // fixture. Recording the update+get last — settling before the update so pause has
  // left UPDATING, and again before the get so the update has — makes the fixture's
  // final state (sampling 25, settled) the one get.golden captures, so replay, which
  // serves that final fixture to every GET, matches get.golden. update merges over
  // the current config because UpdateOnlineEvaluationConfig replaces the whole `rule`;
  // asserting the unset fields survive proves the merge.
  test("updates only the sampling rate, preserving the timeout, insight, and role", async () => {
    await settle();

    const stdout = await run([
      "eval",
      "online-insight",
      "update",
      "--id",
      configId,
      "--sampling-rate",
      "25",
    ]);
    matchGolden(FIXTURES, "update.golden.json", stdout);

    await settle();

    const getStdout = await run(["eval", "online-insight", "get", "--id", configId]);
    matchGolden(FIXTURES, "get.golden.json", getStdout);

    const after = JSON.parse(getStdout);
    expect(after.onlineEvaluationConfigName).toBe(CONFIG_NAME);
    expect(after.rule.samplingConfig.samplingPercentage).toBe(25);
    // --session-timeout-minutes was never passed to update, so the value set at
    // create must survive the whole-`rule` replacement.
    expect(after.rule.sessionConfig.sessionTimeoutMinutes).toBe(30);
    // online-insight carries an insight list, never evaluators; the sampling-only
    // update must leave both untouched.
    expect(after.insights.map((i: { insightId: string }) => i.insightId)).toContain(
      FIXTURE_INSIGHT_ID,
    );
    expect(after.evaluators ?? []).toEqual([]);
    // --role-arn is used verbatim; online-insight never provisions a role.
    expect(after.evaluationExecutionRoleArn).toBe(FIXTURE_ROLE_ARN);
  }, 60_000);

  test("deletes the online insight config", async () => {
    const stdout = await run(["eval", "online-insight", "delete", "--id", configId]);
    matchGolden(FIXTURES, "delete.golden.json", stdout);
  });

  // Guard (Nico's fix): the id-scoped ops model online-insight as a distinct
  // resource, so they GET-verify and reject a plain online-EVAL config instead of
  // silently operating on it. delete rejects at the guard, before any delete call,
  // so aiming it at a real eval config mutates nothing.
  test("rejects a plain online-eval config that has no insights", async () => {
    await expect(
      run(["eval", "online-insight", "get", "--id", EVAL_ONLY_CONFIG_ID, "--json"]),
    ).rejects.toThrow(/is not an online-insight config/);

    await expect(
      run(["eval", "online-insight", "delete", "--id", EVAL_ONLY_CONFIG_ID, "--json"]),
    ).rejects.toThrow(/is not an online-insight config/);
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
