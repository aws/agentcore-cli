import { test, expect, describe } from "bun:test";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/";
import type { CreateOnlineEvalInput, UpdateOnlineEvalInput } from "../types";

async function run(
  args: string[],
  configure?: (core: TestCoreClient) => void,
  ioOptions?: { stdin?: string },
) {
  const core = new TestCoreClient();
  configure?.(core);
  const io = testIO(ioOptions);
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout(), stderr: io.stderr() };
}

function createInput(core: TestCoreClient): CreateOnlineEvalInput {
  const call = core.eval.calls.find((c) => c.method === "createOnlineEvaluationConfig");
  expect(call).toBeDefined();
  return call!.args[0] as CreateOnlineEvalInput;
}

function updateInput(core: TestCoreClient): UpdateOnlineEvalInput {
  const call = core.eval.calls.find((c) => c.method === "updateOnlineEvaluationConfig");
  expect(call).toBeDefined();
  return call!.args[1] as UpdateOnlineEvalInput;
}

const OUTPUT_CONFIG = {
  cloudWatchConfig: {
    logGroupName: "/company/agent-evaluations",
    metricsNamespace: "Company/AgentEvaluations",
    resultDestination: "DEDICATED_LOG_GROUP",
  },
} as const;

describe("eval online-eval create", () => {
  const BASE = [
    "eval",
    "online-eval",
    "create",
    "--name",
    "quality",
    "--agent",
    "r-1",
    "--evaluators",
    "Builtin.Helpfulness",
    "--sampling-rate",
    "10",
  ];

  test("--output-config reaches Core unchanged from inline JSON", async () => {
    const { core } = await run([...BASE, "--output-config", JSON.stringify(OUTPUT_CONFIG)]);
    expect(createInput(core).outputConfig).toEqual(OUTPUT_CONFIG);
  });

  test("--output-config reaches Core unchanged from stdin", async () => {
    const { core } = await run([...BASE, "--output-config", "-"], undefined, {
      stdin: JSON.stringify(OUTPUT_CONFIG),
    });
    expect(createInput(core).outputConfig).toEqual(OUTPUT_CONFIG);
  });

  test("--tags reaches Core as a parsed map", async () => {
    const { core } = await run([...BASE, "--tags", '{"team":"ml-platform","env":"dev"}']);
    expect(createInput(core).tags).toEqual({ team: "ml-platform", env: "dev" });
  });

  test("both are left undefined when omitted, so the service keeps its defaults", async () => {
    const { core } = await run(BASE);
    expect(createInput(core).outputConfig).toBeUndefined();
    expect(createInput(core).tags).toBeUndefined();
  });

  test.each([
    ["--output-config", "{not json", /Invalid JSON for option '--output-config'/],
    ["--tags", "{not json", /Invalid JSON for option '--tags'/],
  ])("malformed %s fails before Core provisions anything", async (flag, value, expected) => {
    const core = new TestCoreClient();
    const io = testIO();
    const root = createRootHandler(core, {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    await expect(
      root.route(["node", "agentcore", ...BASE, flag, value, "--region", "us-west-2"]),
    ).rejects.toThrow(expected);
    expect(core.eval.calls).toEqual([]);
  });

  test("--tags rejects a non-string value rather than passing it to the API", async () => {
    await expect(run([...BASE, "--tags", '{"team":42}'])).rejects.toThrow(
      /Invalid value for option '--tags'/,
    );
  });
});

describe("eval online-eval update", () => {
  const BASE = ["eval", "online-eval", "update", "--id", "online-eval-123"];

  test("--description reaches Core", async () => {
    const { core } = await run([...BASE, "--description", "checks tone on prod traffic"]);
    expect(updateInput(core).description).toBe("checks tone on prod traffic");
  });

  test("--output-config reaches Core unchanged", async () => {
    const { core } = await run([...BASE, "--output-config", JSON.stringify(OUTPUT_CONFIG)]);
    expect(updateInput(core).outputConfig).toEqual(OUTPUT_CONFIG);
  });

  test("an omitted --output-config is not sent, so the destination is preserved", async () => {
    const { core } = await run([...BASE, "--sampling-rate", "20"]);
    expect(updateInput(core).outputConfig).toBeUndefined();
  });

  test("malformed --output-config fails before the initial Get", async () => {
    const core = new TestCoreClient();
    const io = testIO();
    const root = createRootHandler(core, {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    await expect(
      root.route([
        "node",
        "agentcore",
        ...BASE,
        "--output-config",
        "{not json",
        "--region",
        "us-west-2",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--output-config'/);
    expect(core.eval.calls).toEqual([]);
  });

  test.each([
    ["input", "data source moved", "logs:StartQuery and logs:GetQueryResults"],
    ["output", "output destination moved", "logs:PutLogEvents"],
    ["input-and-output", "data source and output destination moved", "logs:PutLogEvents"],
  ] as const)(
    "a %s scope warning names what moved and what to grant",
    async (scope, movedText, action) => {
      const { stderr } = await run(BASE, (c) =>
        c.eval.setOnlineEvalRoleScopeWarning({
          reason: "custom-role",
          roleArn: "arn:aws:iam::123456789012:role/MyRole",
          scope,
          logGroupNames: ["/company/agent-evaluations"],
        }),
      );
      expect(stderr).toContain(movedText);
      expect(stderr).toContain(action);
      expect(stderr).toContain("/company/agent-evaluations");
    },
  );

  test("the scope warning is suppressed under --json", async () => {
    const { stderr } = await run([...BASE, "--json"], (c) =>
      c.eval.setOnlineEvalRoleScopeWarning({
        reason: "custom-role",
        roleArn: "arn:aws:iam::123456789012:role/MyRole",
        scope: "output",
        logGroupNames: ["/company/agent-evaluations"],
      }),
    );
    expect(stderr).toBe("");
  });
});
