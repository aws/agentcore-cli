import { afterAll, describe, expect, test } from "bun:test";
import {
  DeleteConfigurationBundleCommand,
  GetConfigurationBundleCommand,
  DeleteOnlineEvaluationConfigCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DeleteABTestCommand } from "@aws-sdk/client-bedrock-agentcore";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  isRecording,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createControlClient, createDataClient, createIamClient } from "../../../core/factories";
import { abTestExecutionRoleName, deleteAbTestRole } from "../../../core/abTestExecutionRole";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// The read describe records against account 725476964917 (a pre-existing target
// based test); the create describe records against 685197708687 (self-created,
// matching the config-bundle fixtures). Replay is offline and account-agnostic;
// re-record each describe under its own account:
//   RECORD=1 bun test -t "fixture-backed reads"
//   RECORD=1 bun test -t "config-based run"
//   RECORD=1 bun test -t "target-based run"
const FIXTURE_ABTEST_ID = "abvfylatest_abtargettest-a5f5674e07";
const MISSING_ABTEST_ID = "missing-abtest-0000000000";

const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:685197708687:runtime/asdf_MyAgent-3s5axvBC6Q";
const AGENT_ID = "asdf_MyAgent-3s5axvBC6Q";
const EVALUATOR_ID = "Builtin.Helpfulness";
const GATEWAY_ID = "agentcore-cli-gateway-read-fixture-a-l6opkbe2kd";
const BUNDLE_NAME = "agentcore_cli_abtest_run_bundle";
const ONLINE_EVAL_NAME = "agentcore_cli_abtest_run_eval";
const AB_TEST_NAME = "agentcore_cli_abtest_run";

const TB_AB_TEST_NAME = "agentcore_cli_abtest_tb_run";
const TB_ONLINE_EVAL_C = "agentcore_cli_abtest_tb_eval_c";
const TB_ONLINE_EVAL_T1 = "agentcore_cli_abtest_tb_eval_t1";
const TB_GATEWAY_ID = "agentcore-cli-gateway-read-fixture-a-l6opkbe2kd";
const TB_TARGET_C = "agentcore-cli-gateway-read-target-a1";
const TB_TARGET_T1 = "agentcore-cli-gateway-read-target-a2";

const COMPONENTS_V1 = {
  [RUNTIME_ARN]: { configuration: { system_prompt: "A/B run fixture v1." } },
};
const COMPONENTS_V2 = {
  [RUNTIME_ARN]: { configuration: { system_prompt: "A/B run fixture v2." } },
};

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

async function settle(): Promise<void> {
  if (isRecording()) await new Promise((resolve) => setTimeout(resolve, 3000));
}

describe("eval ab-test fixture-backed reads", () => {
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

const created: {
  bundleId?: string;
  v1?: string;
  v2?: string;
  onlineEvalId?: string;
  abTestId?: string;
} = {};

afterAll(async () => {
  if (!isRecording()) return;
  const control = createControlClient({ region: REGION });
  const data = createDataClient({ region: REGION });
  if (created.abTestId) {
    try {
      await data.send(new DeleteABTestCommand({ abTestId: created.abTestId }));
    } catch (error) {
      console.error("cleanup ab-test:", error);
    }
    try {
      await deleteAbTestRole(
        createIamClient({ region: REGION }),
        abTestExecutionRoleName(AB_TEST_NAME),
      );
    } catch (error) {
      console.error("cleanup ab-test role:", error);
    }
  }
  if (created.onlineEvalId) {
    try {
      await control.send(
        new DeleteOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: created.onlineEvalId }),
      );
    } catch (error) {
      console.error("cleanup online-eval:", error);
    }
  }
  if (created.bundleId) {
    try {
      await control.send(
        new GetConfigurationBundleCommand({ bundleId: created.bundleId, branchName: "mainline" }),
      );
      await control.send(new DeleteConfigurationBundleCommand({ bundleId: created.bundleId }));
    } catch (error) {
      if ((error as Error).name !== "ResourceNotFoundException") {
        console.error("cleanup bundle:", error);
      }
    }
  }
});

describe("eval ab-test config-based run", () => {
  test("provisions a bundle with two versions", async () => {
    const v1 = await run([
      "eval",
      "config-bundle",
      "create",
      "--name",
      BUNDLE_NAME,
      "--components",
      JSON.stringify(COMPONENTS_V1),
    ]);
    matchGolden(FIXTURES, "run-bundle-create.golden.json", v1);
    const first = JSON.parse(v1);
    created.bundleId = first.bundleId;
    created.v1 = first.versionId;

    await settle();

    const v2 = await run([
      "eval",
      "config-bundle",
      "update",
      "--id",
      created.bundleId!,
      "--components",
      JSON.stringify(COMPONENTS_V2),
      "--commit-message",
      "A/B run fixture v2",
    ]);
    matchGolden(FIXTURES, "run-bundle-update.golden.json", v2);
    created.v2 = JSON.parse(v2).versionId;
    expect(created.v2).not.toBe(created.v1);
  }, 180_000);

  test("provisions a paused online evaluation config", async () => {
    const out = await run([
      "eval",
      "online-eval",
      "create",
      "--name",
      ONLINE_EVAL_NAME,
      "--agent",
      AGENT_ID,
      "--evaluator",
      EVALUATOR_ID,
      "--sampling-rate",
      "100",
      "--enable-on-create",
      "false",
    ]);
    matchGolden(FIXTURES, "run-online-eval.golden.json", out);
    created.onlineEvalId = JSON.parse(out).onlineEvaluationConfigId;
  }, 180_000);

  test("runs a paused config-based A/B test", async () => {
    const out = await run([
      "eval",
      "ab-test",
      "config-based",
      "run",
      "--name",
      AB_TEST_NAME,
      "--gateway",
      GATEWAY_ID,
      "--control",
      JSON.stringify({ "config-bundle": created.bundleId, "bundle-version": created.v1 }),
      "--treatment",
      JSON.stringify({ "config-bundle": created.bundleId, "bundle-version": created.v2 }),
      "--online-eval",
      created.onlineEvalId!,
      "--treatment-weight",
      "20",
      "--enable-on-create",
      "false",
    ]);
    matchGolden(FIXTURES, "run.golden.json", out);
    const abTest = JSON.parse(out);
    created.abTestId = abTest.abTestId;
    expect(abTest.abTestId).toBeString();
    expect(abTest.executionStatus).toBe("NOT_STARTED");
  }, 180_000);
});

const createdTB: { evalC?: string; evalT1?: string; abTestId?: string } = {};

afterAll(async () => {
  if (!isRecording()) return;
  const control = createControlClient({ region: REGION });
  const data = createDataClient({ region: REGION });
  if (createdTB.abTestId) {
    try {
      await data.send(new DeleteABTestCommand({ abTestId: createdTB.abTestId }));
    } catch (error) {
      console.error("cleanup tb ab-test:", error);
    }
    try {
      await deleteAbTestRole(
        createIamClient({ region: REGION }),
        abTestExecutionRoleName(TB_AB_TEST_NAME),
      );
    } catch (error) {
      console.error("cleanup tb ab-test role:", error);
    }
  }
  for (const id of [createdTB.evalC, createdTB.evalT1]) {
    if (!id) continue;
    try {
      await control.send(new DeleteOnlineEvaluationConfigCommand({ onlineEvaluationConfigId: id }));
    } catch (error) {
      console.error("cleanup tb online-eval:", error);
    }
  }
});

describe("eval ab-test target-based run", () => {
  test("provisions two paused online evaluation configs", async () => {
    const c = await run([
      "eval",
      "online-eval",
      "create",
      "--name",
      TB_ONLINE_EVAL_C,
      "--agent",
      AGENT_ID,
      "--evaluator",
      EVALUATOR_ID,
      "--sampling-rate",
      "100",
      "--enable-on-create",
      "false",
    ]);
    matchGolden(FIXTURES, "tb-online-eval-c.golden.json", c);
    createdTB.evalC = JSON.parse(c).onlineEvaluationConfigId;

    await settle();

    const t1 = await run([
      "eval",
      "online-eval",
      "create",
      "--name",
      TB_ONLINE_EVAL_T1,
      "--agent",
      AGENT_ID,
      "--evaluator",
      EVALUATOR_ID,
      "--sampling-rate",
      "100",
      "--enable-on-create",
      "false",
    ]);
    matchGolden(FIXTURES, "tb-online-eval-t1.golden.json", t1);
    createdTB.evalT1 = JSON.parse(t1).onlineEvaluationConfigId;
  }, 180_000);

  test("runs a paused target-based A/B test", async () => {
    const out = await run([
      "eval",
      "ab-test",
      "target-based",
      "run",
      "--name",
      TB_AB_TEST_NAME,
      "--gateway",
      TB_GATEWAY_ID,
      "--control",
      JSON.stringify({ "gateway-target": TB_TARGET_C, "online-eval": createdTB.evalC }),
      "--treatment",
      JSON.stringify({ "gateway-target": TB_TARGET_T1, "online-eval": createdTB.evalT1 }),
      "--treatment-weight",
      "20",
      "--enable-on-create",
      "false",
    ]);
    matchGolden(FIXTURES, "tb-run.golden.json", out);
    const abTest = JSON.parse(out);
    createdTB.abTestId = abTest.abTestId;
    expect(abTest.abTestId).toBeString();
    expect(abTest.executionStatus).toBe("NOT_STARTED");
  }, 180_000);
});
