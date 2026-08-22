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

// Record with RECORD=1 bun test src/handlers/eval/online-eval/online-eval.test.tsx
// The RECORD run creates one online evaluation config against a real runtime,
// exercises get/list/update/pause/resume against it, then deletes it, so a
// recording leaves no residue. The id the service assigns is captured from the
// recorded create response, which keeps the dependent fixtures (keyed by request
// input) stable on replay.
const CONFIG_NAME = "agentcore_cli_online_eval_fixture";

// CreateOnlineEvaluationConfig validates the referenced evaluator, so recording
// uses a builtin that needs no setup.
const FIXTURE_EVALUATOR_ID = "Builtin.Helpfulness";

// The runtime whose traffic the recorded config samples. `--agent` resolves it to
// the CloudWatch log group / service name pair, so the id must exist in the
// fixture account. It is only referenced, never invoked.
const FIXTURE_AGENT_ID = "testAgent_Agent-wm9hYBD93Y";
const FIXTURE_AGENT_NAME = "testAgent_Agent";

// The execution role every create supplies. --role-arn is required now; the CLI
// no longer provisions a role, so this must be an assumable role in the account.
const FIXTURE_ROLE_ARN = "arn:aws:iam::725476964917:role/AgentCoreEvalsSDK-us-west-2-a6864eb339";

// Online evaluation config ids match `[a-zA-Z][a-zA-Z0-9-_]{0,99}-[a-zA-Z0-9]{10}`.
// An id failing that pattern is rejected as a ValidationException before any
// lookup, so this one is well-formed and simply absent, to reach the not-found path.
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

describe("eval online-eval command hierarchy", () => {
  test("registers the eval → online-eval command tree", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const onlineEval = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "online-eval");

    expect(onlineEval?.children().map((c) => c.name())).toEqual([
      "create",
      "get",
      "list",
      "update",
      "pause",
      "resume",
      "delete",
    ]);
  });

  test("prints help for bare `eval online-eval --json` without an SDK call", async () => {
    // Under --json the empty-invocation TUI middleware prints help instead of
    // opening the interactive UI.
    const stdout = await run(["eval", "online-eval", "--json"]);
    expect(stdout).toContain("Usage: agentcore eval online-eval");
    expect(stdout).toContain("Commands:");
  });

  // A bare read leaf (no flags, no --json) opens the interactive TUI, which the
  // headless test IO cannot host — proving the empty-invocation middleware is
  // wired onto the online-eval commands.
  test.each([["get"], ["list"]] as const)(
    "opens the TUI for a bare `eval online-eval %s` leaf",
    async (command) => {
      await expect(run(["eval", "online-eval", command])).rejects.toThrow(
        "interactive mode requires a TTY on stdin and stdout",
      );
    },
  );

  test("runs normal validation for a bare CLI-only command", async () => {
    await expect(run(["eval", "online-eval", "create"])).rejects.toThrow(
      "required option '--name <name>' not specified",
    );
  });
});

describe("online-eval CRUDL", () => {
  test("creates an online evaluation config from an agent", async () => {
    const stdout = await run([
      "eval",
      "online-eval",
      "create",
      "--name",
      CONFIG_NAME,
      "--agent",
      FIXTURE_AGENT_ID,
      "--evaluator",
      FIXTURE_EVALUATOR_ID,
      "--sampling-rate",
      "10",
      "--session-timeout-minutes",
      "30",
      "--role-arn",
      FIXTURE_ROLE_ARN,
      "--enable-on-create",
      "false",
    ]);

    matchGolden(FIXTURES, "create.golden.json", stdout);
    configId = JSON.parse(stdout).onlineEvaluationConfigId;
    expect(configId).toBeString();
  });

  test("lists online evaluation configs", async () => {
    // --json forces the headless path; a bare `list` (no flags) would otherwise
    // open the TUI under the empty-invocation middleware.
    const stdout = await run(["eval", "online-eval", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).onlineEvaluationConfigs).toBeArray();
  });

  test("paginates the list with --max-results and --next-token", async () => {
    const firstPage = await run(["eval", "online-eval", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.onlineEvaluationConfigs).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "eval",
      "online-eval",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).onlineEvaluationConfigs).toHaveLength(1);
  });

  // update merges over the current config because UpdateOnlineEvaluationConfig
  // replaces the whole `rule`; this asserts the unset fields survive the round trip.
  test("updates only the sampling rate, preserving the session timeout", async () => {
    const stdout = await run([
      "eval",
      "online-eval",
      "update",
      "--id",
      configId,
      "--sampling-rate",
      "25",
    ]);

    matchGolden(FIXTURES, "update.golden.json", stdout);

    // `get` is asserted here rather than in its own test: fixtures are keyed by
    // request input, so a second `get` of this id would share (and disagree with)
    // this one's recording.
    const getStdout = await run(["eval", "online-eval", "get", "--id", configId]);
    matchGolden(FIXTURES, "get.golden.json", getStdout);

    const after = JSON.parse(getStdout);
    expect(after.onlineEvaluationConfigName).toBe(CONFIG_NAME);
    expect(after.rule.samplingConfig.samplingPercentage).toBe(25);
    // `update` replaces the whole `rule`, and --session-timeout-minutes was never
    // passed to it, so the value set at create must survive the merge.
    expect(after.rule.sessionConfig.sessionTimeoutMinutes).toBe(30);
    // `--agent` derives the log group from the runtime *id* and the service name
    // from the runtime *name*; the two are not interchangeable.
    const cloudWatchLogs = after.dataSourceConfig.cloudWatchLogs;
    expect(cloudWatchLogs.logGroupNames).toEqual([
      `/aws/bedrock-agentcore/runtimes/${FIXTURE_AGENT_ID}-DEFAULT`,
    ]);
    expect(cloudWatchLogs.serviceNames).toEqual([`${FIXTURE_AGENT_NAME}.DEFAULT`]);
  });

  // resume and pause are asserted in one test because the service rejects an
  // update while the previous one is still settling (ConflictException, state
  // UPDATING). Recording therefore waits for the config to leave UPDATING between
  // the two calls; on replay the fixtures are served instantly and the wait is a
  // no-op, so the test stays fast and deterministic.
  test("resumes then pauses the config, toggling execution status", async () => {
    const resumeStdout = await run(["eval", "online-eval", "resume", "--id", configId]);
    matchGolden(FIXTURES, "resume.golden.json", resumeStdout);
    expect(JSON.parse(resumeStdout).executionStatus).toBe("ENABLED");

    await settle();

    const pauseStdout = await run(["eval", "online-eval", "pause", "--id", configId]);
    matchGolden(FIXTURES, "pause.golden.json", pauseStdout);
    expect(JSON.parse(pauseStdout).executionStatus).toBe("DISABLED");
    // Extended timeout so the settle() wait fits while recording; it is a no-op on replay.
  }, 60_000);

  test("deletes the online evaluation config", async () => {
    // The preceding pause leaves the config UPDATING, and the service rejects a
    // delete in that state. Wait it out while recording; a no-op on replay.
    await settle();
    const stdout = await run(["eval", "online-eval", "delete", "--id", configId]);
    matchGolden(FIXTURES, "delete.golden.json", stdout);
  }, 30_000);

  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["eval", "online-eval", "get", "--id", MISSING_CONFIG_ID]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});

// Flag parsing never reaches the SDK, so these need no fixtures.
describe("flag validation", () => {
  test("create requires a data source", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "create",
        "--name",
        CONFIG_NAME,
        "--evaluator",
        FIXTURE_EVALUATOR_ID,
        "--sampling-rate",
        "10",
        "--role-arn",
        FIXTURE_ROLE_ARN,
      ]),
    ).rejects.toThrow(/exactly one of '--agent' or '--data-source-config'/);
  });

  test("create rejects both --agent and --data-source-config", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
        "--evaluator",
        FIXTURE_EVALUATOR_ID,
        "--sampling-rate",
        "10",
        "--role-arn",
        FIXTURE_ROLE_ARN,
      ]),
    ).rejects.toThrow(/exactly one of '--agent' or '--data-source-config'/);
  });

  test("create rejects --endpoint without --agent", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "create",
        "--name",
        CONFIG_NAME,
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
        "--endpoint",
        "prod",
        "--evaluator",
        FIXTURE_EVALUATOR_ID,
        "--sampling-rate",
        "10",
        "--role-arn",
        FIXTURE_ROLE_ARN,
      ]),
    ).rejects.toThrow(/'--endpoint' can only be used with '--agent'/);
  });

  test("create rejects malformed --data-source-config JSON", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "create",
        "--name",
        CONFIG_NAME,
        "--data-source-config",
        "not-json",
        "--evaluator",
        FIXTURE_EVALUATOR_ID,
        "--sampling-rate",
        "10",
        "--role-arn",
        FIXTURE_ROLE_ARN,
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--data-source-config'/);
  });

  test("create requires --role-arn", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "create",
        "--name",
        CONFIG_NAME,
        "--agent",
        FIXTURE_AGENT_ID,
        "--evaluator",
        FIXTURE_EVALUATOR_ID,
        "--sampling-rate",
        "10",
      ]),
    ).rejects.toThrow(/required option '--role-arn <role-arn>' not specified/);
  });

  test("update rejects --endpoint together with --clear-endpoint", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "update",
        "--id",
        "some-config-0000000000",
        "--endpoint",
        "staging",
        "--clear-endpoint",
        "true",
      ]),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("update rejects --agent together with --data-source-config", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "update",
        "--id",
        "some-config-0000000000",
        "--agent",
        FIXTURE_AGENT_ID,
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
      ]),
    ).rejects.toThrow(/'--agent' and '--data-source-config' are mutually exclusive/);
  });

  test("update rejects --endpoint together with --data-source-config", async () => {
    await expect(
      run([
        "eval",
        "online-eval",
        "update",
        "--id",
        "some-config-0000000000",
        "--endpoint",
        "prod",
        "--data-source-config",
        '{"cloudWatchLogs":{"logGroupNames":["/custom"],"serviceNames":["svc"]}}',
      ]),
    ).rejects.toThrow(/'--endpoint' cannot be combined with '--data-source-config'/);
  });

  // --json forces the headless path so the required-flag error surfaces; without
  // it a bare invocation opens the TUI under the empty-invocation middleware.
  test.each(["get", "update", "pause", "resume", "delete"])("%s requires --id", async (command) => {
    await expect(run(["eval", "online-eval", command, "--json"])).rejects.toThrow(
      /required option '--id <id>' not specified/,
    );
  });
});
