import { test, expect, describe } from "bun:test";
import type { GetABTestResponse, ListABTestsResponse } from "@aws-sdk/client-bedrock-agentcore";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { TestGlobalConfigAccessor } from "../../../testing/";

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout() };
}

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:ab-test/ab-test-1";

const GET_RESPONSE = {
  abTestId: "ab-test-1",
  abTestArn: ARN,
  name: "orders-v2",
  status: "ACTIVE",
  executionStatus: "RUNNING",
  gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders",
  variants: [],
  evaluationConfig: {
    onlineEvaluationConfigArn:
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:online-evaluation-config/x",
  },
  createdAt: new Date("2026-07-19T01:02:03.000Z"),
  updatedAt: new Date("2026-07-20T12:34:56.000Z"),
} satisfies GetABTestResponse;

const LIST_RESPONSE = {
  abTests: [{ abTestId: "ab-test-1", status: "ACTIVE" }],
  nextToken: "next",
} as ListABTestsResponse;

const RUN_BASE = [
  "eval",
  "ab-test",
  "config-based",
  "run",
  "--name",
  "orders-v2",
  "--gateway",
  "orders-gateway-abc123",
  "--control",
  '{"config-bundle":"orders-prompt-abc","bundle-version":"1111"}',
  "--treatment",
  '{"config-bundle":"orders-prompt-abc","bundle-version":"2222"}',
  "--online-eval",
  "online-eval-abc123",
  "--json",
];

describe("eval ab-test command hierarchy", () => {
  test("registers get, list, pause, resume, stop, delete, config-based", () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const group = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "ab-test");
    expect(group?.children().map((c) => c.name())).toEqual([
      "get",
      "list",
      "pause",
      "resume",
      "stop",
      "delete",
      "config-based",
      "target-based",
    ]);
    const cb = group?.children().find((c) => c.name() === "config-based");
    expect(cb?.children().map((c) => c.name())).toEqual(["run"]);
    const tb = group?.children().find((c) => c.name() === "target-based");
    expect(tb?.children().map((c) => c.name())).toEqual(["run"]);
  });
});

describe("eval ab-test get", () => {
  test("returns the test by id", async () => {
    const { core, stdout } = await run(
      ["eval", "ab-test", "get", "--id", "ab-test-1", "--json"],
      (c) => c.eval.setAbTestGetResponse(GET_RESPONSE),
    );
    expect(JSON.parse(stdout).abTestId).toBe("ab-test-1");
    expect(core.eval.calls).toEqual([
      { method: "getABTest", args: ["ab-test-1", { region: "us-west-2" }] },
    ]);
  });

  test("requires --id", async () => {
    await expect(run(["eval", "ab-test", "get", "--json"])).rejects.toThrow(/--id/);
  });

  test("surfaces a Core error", async () => {
    await expect(
      run(["eval", "ab-test", "get", "--id", "missing", "--json"], (c) =>
        c.eval.setError(new Error("ResourceNotFound")),
      ),
    ).rejects.toThrow(/ResourceNotFound/);
  });
});

describe("eval ab-test list", () => {
  test("passes pagination through", async () => {
    const { core, stdout } = await run(
      ["eval", "ab-test", "list", "--max-results", "10", "--json"],
      (c) => c.eval.setAbTestListResponse(LIST_RESPONSE),
    );
    expect(JSON.parse(stdout).nextToken).toBe("next");
    expect(core.eval.calls[0]?.args).toEqual([undefined, 10, { region: "us-west-2" }]);
  });

  test("surfaces a Core error", async () => {
    await expect(
      run(["eval", "ab-test", "list", "--json"], (c) => c.eval.setError(new Error("boom"))),
    ).rejects.toThrow(/boom/);
  });
});

describe("eval ab-test transitions", () => {
  test.each([
    ["pause", "PAUSED"],
    ["resume", "RUNNING"],
    ["stop", "STOPPED"],
  ] as const)("%s sets executionStatus %s via Core", async (command, status) => {
    const { core } = await run(["eval", "ab-test", command, "--id", "ab-test-1", "--json"], (c) =>
      c.eval.setAbTestUpdateResponse({
        abTestId: "ab-test-1",
        abTestArn: ARN,
        status: "ACTIVE",
        executionStatus: status,
        updatedAt: new Date("2026-07-20T12:34:56.000Z"),
      }),
    );
    expect(core.eval.calls).toEqual([
      { method: "setABTestExecutionStatus", args: ["ab-test-1", status, { region: "us-west-2" }] },
    ]);
  });

  test.each(["pause", "resume", "stop"] as const)("%s requires --id", async (command) => {
    await expect(run(["eval", "ab-test", command, "--json"])).rejects.toThrow(/--id/);
  });

  test.each(["pause", "resume", "stop"] as const)("%s surfaces a Core error", async (command) => {
    await expect(
      run(["eval", "ab-test", command, "--id", "ab-test-1", "--json"], (c) =>
        c.eval.setError(new Error("invalid transition")),
      ),
    ).rejects.toThrow(/invalid transition/);
  });
});

describe("eval ab-test delete", () => {
  test("deletes by id via Core", async () => {
    const { core, stdout } = await run(
      ["eval", "ab-test", "delete", "--id", "ab-test-1", "--json"],
      (c) =>
        c.eval.setAbTestDeleteResponse({
          abTestId: "ab-test-1",
          abTestArn: ARN,
          status: "DELETING",
        }),
    );
    expect(JSON.parse(stdout).abTestId).toBe("ab-test-1");
    expect(core.eval.calls).toEqual([
      { method: "deleteABTest", args: ["ab-test-1", { region: "us-west-2" }] },
    ]);
  });

  test("requires --id", async () => {
    await expect(run(["eval", "ab-test", "delete", "--json"])).rejects.toThrow(/--id/);
  });

  test("surfaces a Core error (e.g. not stopped)", async () => {
    await expect(
      run(["eval", "ab-test", "delete", "--id", "ab-test-1", "--json"], (c) =>
        c.eval.setError(new Error("must be stopped")),
      ),
    ).rejects.toThrow(/must be stopped/);
  });
});

describe("eval ab-test config-based run validation", () => {
  test.each(["name", "gateway", "control", "treatment", "online-eval"] as const)(
    "requires --%s",
    async (missing) => {
      const args = RUN_BASE.filter(
        (a, i) => a !== `--${missing}` && RUN_BASE[i - 1] !== `--${missing}`,
      );
      await expect(run(args)).rejects.toThrow(new RegExp(`--${missing}`));
    },
  );

  test("rejects malformed --control JSON", async () => {
    const args = RUN_BASE.map((a) =>
      a === '{"config-bundle":"orders-prompt-abc","bundle-version":"1111"}' ? "notjson" : a,
    );
    await expect(run(args)).rejects.toThrow(/Invalid JSON/);
  });

  test("rejects a mis-shaped --control object", async () => {
    const args = RUN_BASE.map((a) =>
      a === '{"config-bundle":"orders-prompt-abc","bundle-version":"1111"}'
        ? '{"wrong":"shape"}'
        : a,
    );
    await expect(run(args)).rejects.toThrow(/--control must be/);
  });

  test("rejects identical control/treatment", async () => {
    const same = '{"config-bundle":"b","bundle-version":"same"}';
    await expect(
      run([
        "eval",
        "ab-test",
        "config-based",
        "run",
        "--name",
        "x",
        "--gateway",
        "g",
        "--control",
        same,
        "--treatment",
        same,
        "--online-eval",
        "o",
        "--json",
      ]),
    ).rejects.toThrow(/must reference a different/);
  });

  test.each(["0", "100"])("rejects --treatment-weight %s", async (w) => {
    await expect(run([...RUN_BASE, "--treatment-weight", w])).rejects.toThrow(/1 and 99/);
  });

  test("passes --gateway-filter through as a GatewayFilter", async () => {
    const { core } = await run(
      [...RUN_BASE, "--gateway-filter", '{"targetPaths":["/orders/checkout"]}'],
      (c) =>
        c.eval.setAbTestCreateResponse({
          abTestId: "x",
          abTestArn: ARN,
          name: "x",
          status: "CREATING",
          executionStatus: "NOT_STARTED",
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
        }),
    );
    const call = core.eval.calls.find((c) => c.method === "createConfigBasedABTest");
    expect(call).toBeDefined();
    expect((call!.args[0] as { gatewayFilter?: unknown }).gatewayFilter).toEqual({
      targetPaths: ["/orders/checkout"],
    });
  });
});

describe("eval ab-test target-based run validation", () => {
  const TB_BASE = [
    "eval",
    "ab-test",
    "target-based",
    "run",
    "--name",
    "orders-v2-canary",
    "--gateway",
    "orders-gateway-abc123",
    "--control",
    '{"gateway-target":"orders-prod-target","online-eval":"prod-quality"}',
    "--treatment",
    '{"gateway-target":"orders-v2-target","online-eval":"v2-quality"}',
    "--json",
  ];

  test.each(["name", "gateway", "control", "treatment"] as const)(
    "requires --%s",
    async (missing) => {
      const args = TB_BASE.filter(
        (a, i) => a !== `--${missing}` && TB_BASE[i - 1] !== `--${missing}`,
      );
      await expect(run(args)).rejects.toThrow(new RegExp(`--${missing}`));
    },
  );

  test("rejects a mis-shaped --control object", async () => {
    const args = TB_BASE.map((a) =>
      a === '{"gateway-target":"orders-prod-target","online-eval":"prod-quality"}'
        ? '{"wrong":"shape"}'
        : a,
    );
    await expect(run(args)).rejects.toThrow(/--control must be/);
  });

  test("rejects identical control/treatment targets", async () => {
    const same = '{"gateway-target":"t","online-eval":"e"}';
    await expect(
      run([
        "eval",
        "ab-test",
        "target-based",
        "run",
        "--name",
        "x",
        "--gateway",
        "g",
        "--control",
        same,
        "--treatment",
        same,
        "--json",
      ]),
    ).rejects.toThrow(/different gateway targets/);
  });

  test("maps flags to a createTargetBasedABTest call", async () => {
    const { core } = await run([...TB_BASE, "--treatment-weight", "20"], (c) =>
      c.eval.setAbTestCreateResponse({
        abTestId: "x",
        abTestArn: ARN,
        name: "x",
        status: "CREATING",
        executionStatus: "RUNNING",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      }),
    );
    const call = core.eval.calls.find((c) => c.method === "createTargetBasedABTest");
    expect(call).toBeDefined();
    expect(call!.args[0]).toEqual({
      name: "orders-v2-canary",
      gateway: "orders-gateway-abc123",
      control: { gatewayTarget: "orders-prod-target", onlineEval: "prod-quality" },
      treatment: { gatewayTarget: "orders-v2-target", onlineEval: "v2-quality" },
      treatmentWeight: 20,
      gatewayFilter: undefined,
      roleArn: undefined,
      enableOnCreate: undefined,
    });
  });
});
