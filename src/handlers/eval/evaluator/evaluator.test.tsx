import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluatorType, type EvaluatorSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";
import { createRootHandler } from "../../index";
import { ratingScaleFromPreset } from "../ratingScale";

const REGION = "us-west-2";

// run drives the real router (parsing → middleware → handler) against a
// TestCoreClient so we can assert on the exact request a handler built, plus the
// captured stdout. Optional `stdin` seeds the in-memory input stream for `-`.
function run(core: TestCoreClient, args: string[], stdin?: string) {
  const io = testIO();
  if (stdin !== undefined) {
    io.io.stdin.push(stdin);
    io.io.stdin.push(null);
  }
  const root = createRootHandler(core, { io: io.io, logger: createSilentLogger() });
  return root.route(["node", "agentcore", ...args, "--region", REGION]).then(() => io.stdout());
}

describe("eval command hierarchy", () => {
  test("registers the eval → evaluator command tree", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
    });
    const evaluator = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "evaluator");

    expect(evaluator?.children().map((c) => c.name())).toEqual([
      "llm-as-a-judge",
      "code-based",
      "get",
      "list",
      "delete",
    ]);
    expect(
      evaluator
        ?.children()
        .find((c) => c.name() === "llm-as-a-judge")
        ?.children()
        .map((c) => c.name()),
    ).toEqual(["create", "update"]);
    expect(
      evaluator
        ?.children()
        .find((c) => c.name() === "code-based")
        ?.children()
        .map((c) => c.name()),
    ).toEqual(["create", "update"]);
  });

  test.each([
    "eval",
    "eval evaluator",
    "eval evaluator llm-as-a-judge",
    "eval evaluator code-based",
  ])("prints help for bare `%s` without an SDK call", async (command) => {
    const core = new TestCoreClient();
    const stdout = await run(core, command.split(" "));
    expect(stdout).toContain(`Usage: agentcore ${command}`);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("llm-as-a-judge create", () => {
  test("builds the request with a preset rating scale", async () => {
    const core = new TestCoreClient();
    await run(core, [
      "eval",
      "evaluator",
      "llm-as-a-judge",
      "create",
      "--name",
      "order-support-quality",
      "--level",
      "SESSION",
      "--model",
      "us.anthropic.claude-sonnet-4-5",
      "--instructions",
      "Judge the response.",
      "--rating-scale",
      "1-5-quality",
    ]);

    expect(core.eval.calls).toHaveLength(1);
    const [request] = core.eval.calls[0]!.args as [any];
    expect(request.evaluatorName).toBe("order-support-quality");
    expect(request.level).toBe("SESSION");
    expect(request.evaluatorConfig.llmAsAJudge.instructions).toBe("Judge the response.");
    expect(
      request.evaluatorConfig.llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig.modelId,
    ).toBe("us.anthropic.claude-sonnet-4-5");
    expect(request.evaluatorConfig.llmAsAJudge.ratingScale).toEqual(
      ratingScaleFromPreset("1-5-quality"),
    );
  });

  test("reads instructions from a file:// path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-test-"));
    const file = join(dir, "instructions.txt");
    writeFileSync(file, "Instructions from file.");
    try {
      const core = new TestCoreClient();
      await run(core, [
        "eval",
        "evaluator",
        "llm-as-a-judge",
        "create",
        "--name",
        "x",
        "--level",
        "TRACE",
        "--model",
        "m",
        "--instructions",
        `file://${file}`,
        "--rating-scale",
        "pass-fail",
      ]);
      const [request] = core.eval.calls[0]!.args as [any];
      expect(request.evaluatorConfig.llmAsAJudge.instructions).toBe("Instructions from file.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads instructions from stdin with `-`", async () => {
    const core = new TestCoreClient();
    await run(
      core,
      [
        "eval",
        "evaluator",
        "llm-as-a-judge",
        "create",
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        "m",
        "--instructions",
        "-",
        "--rating-scale",
        "1-3-simple",
      ],
      "Instructions from stdin.",
    );
    const [request] = core.eval.calls[0]!.args as [any];
    expect(request.evaluatorConfig.llmAsAJudge.instructions).toBe("Instructions from stdin.");
  });

  test("accepts a custom rating scale via --rating-scale-json", async () => {
    const core = new TestCoreClient();
    const scale = JSON.stringify({ numerical: [{ value: 1, label: "L", definition: "d" }] });
    await run(core, [
      "eval",
      "evaluator",
      "llm-as-a-judge",
      "create",
      "--name",
      "x",
      "--level",
      "SESSION",
      "--model",
      "m",
      "--instructions",
      "i",
      "--rating-scale-json",
      scale,
    ]);
    const [request] = core.eval.calls[0]!.args as [any];
    expect(request.evaluatorConfig.llmAsAJudge.ratingScale).toEqual(JSON.parse(scale));
  });

  test.each([
    [
      "missing --name",
      ["--level", "SESSION", "--model", "m", "--instructions", "i", "--rating-scale", "pass-fail"],
      /--name/,
    ],
    [
      "missing --level",
      ["--name", "x", "--model", "m", "--instructions", "i", "--rating-scale", "pass-fail"],
      /--level/,
    ],
    [
      "missing --model",
      ["--name", "x", "--level", "SESSION", "--instructions", "i", "--rating-scale", "pass-fail"],
      /--model/,
    ],
    [
      "missing --instructions",
      ["--name", "x", "--level", "SESSION", "--model", "m", "--rating-scale", "pass-fail"],
      /--instructions/,
    ],
    [
      "missing rating scale",
      ["--name", "x", "--level", "SESSION", "--model", "m", "--instructions", "i"],
      /rating-scale/,
    ],
  ] as const)("rejects %s", async (_label, extra, message) => {
    const core = new TestCoreClient();
    expect(run(core, ["eval", "evaluator", "llm-as-a-judge", "create", ...extra])).rejects.toThrow(
      message,
    );
  });

  test("rejects both --rating-scale and --rating-scale-json", async () => {
    const core = new TestCoreClient();
    expect(
      run(core, [
        "eval",
        "evaluator",
        "llm-as-a-judge",
        "create",
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        "m",
        "--instructions",
        "i",
        "--rating-scale",
        "pass-fail",
        "--rating-scale-json",
        "{}",
      ]),
    ).rejects.toThrow(/only one of/);
  });
});

describe("code-based create", () => {
  test("builds the request and omits timeout when not given", async () => {
    const core = new TestCoreClient();
    await run(core, [
      "eval",
      "evaluator",
      "code-based",
      "create",
      "--name",
      "refund-policy",
      "--level",
      "SESSION",
      "--lambda-arn",
      "arn:aws:lambda:us-west-2:123456789012:function:refund",
    ]);
    const [request] = core.eval.calls[0]!.args as [any];
    expect(request.evaluatorConfig.codeBased.lambdaConfig.lambdaArn).toContain("function:refund");
    expect(request.evaluatorConfig.codeBased.lambdaConfig.lambdaTimeoutInSeconds).toBeUndefined();
  });

  test("passes timeout through when given", async () => {
    const core = new TestCoreClient();
    await run(core, [
      "eval",
      "evaluator",
      "code-based",
      "create",
      "--name",
      "x",
      "--level",
      "SESSION",
      "--lambda-arn",
      "arn:x",
      "--timeout",
      "30",
    ]);
    const [request] = core.eval.calls[0]!.args as [any];
    expect(request.evaluatorConfig.codeBased.lambdaConfig.lambdaTimeoutInSeconds).toBe(30);
  });

  test("rejects a missing --lambda-arn", async () => {
    const core = new TestCoreClient();
    expect(
      run(core, ["eval", "evaluator", "code-based", "create", "--name", "x", "--level", "SESSION"]),
    ).rejects.toThrow(/--lambda-arn/);
  });
});

describe("update / get / delete required flags", () => {
  test.each([
    ["llm-as-a-judge update", ["eval", "evaluator", "llm-as-a-judge", "update"]],
    ["code-based update", ["eval", "evaluator", "code-based", "update"]],
    ["get", ["eval", "evaluator", "get"]],
    ["delete", ["eval", "evaluator", "delete"]],
  ] as const)("`%s` requires --id", async (_label, args) => {
    const core = new TestCoreClient();
    expect(run(core, [...args])).rejects.toThrow(/--id/);
  });

  test("delete requires --yes", async () => {
    const core = new TestCoreClient();
    expect(run(core, ["eval", "evaluator", "delete", "--id", "e-1"])).rejects.toThrow(/--yes/);
  });

  test("delete proceeds with --yes", async () => {
    const core = new TestCoreClient();
    await run(core, ["eval", "evaluator", "delete", "--id", "e-1", "--yes"]);
    expect(core.eval.calls).toEqual([
      { method: "deleteEvaluator", args: ["e-1", { region: REGION, endpointUrl: undefined }] },
    ]);
  });
});

describe("list filtering", () => {
  const evaluators = [
    { evaluatorId: "b1", evaluatorType: EvaluatorType.BUILTIN },
    { evaluatorId: "c1", evaluatorType: EvaluatorType.CODE },
    { evaluatorId: "l1", evaluatorType: EvaluatorType.CUSTOM },
  ] as unknown as EvaluatorSummary[];

  test.each([
    ["Builtin", ["b1"]],
    ["code-based", ["c1"]],
    ["llm-as-a-judge", ["l1"]],
  ] as const)("filters the returned page by --type %s", async (type, expectedIds) => {
    const core = new TestCoreClient();
    core.eval.setListResponse({ evaluators });
    const stdout = await run(core, ["eval", "evaluator", "list", "--type", type, "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.evaluators.map((e: { evaluatorId: string }) => e.evaluatorId)).toEqual(
      expectedIds,
    );
  });

  test("returns all evaluators when --type is omitted", async () => {
    const core = new TestCoreClient();
    core.eval.setListResponse({ evaluators });
    const stdout = await run(core, ["eval", "evaluator", "list", "--json"]);
    expect(JSON.parse(stdout).evaluators).toHaveLength(3);
  });
});
