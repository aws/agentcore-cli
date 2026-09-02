import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../../testing";
import { InputValidationError } from "../../../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-code-eval-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(args: string[]) {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io };
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

const spec = (projectRoot: string) =>
  Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
const evaluator = async (projectRoot: string, name: string) =>
  ((await spec(projectRoot)).evaluators ?? []).find((e: { name: string }) => e.name === name);

describe("project add evaluator code-based", () => {
  test("3P metric → managed config + scaffolded, rendered Lambda source", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "answer_faithfulness",
      "--level",
      "SESSION",
      "--metric",
      "deepeval.FaithfulnessMetric",
      "--model",
      "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
    ]);

    expect(await evaluator(projectRoot, "answer_faithfulness")).toMatchObject({
      name: "answer_faithfulness",
      level: "SESSION",
      config: {
        codeBased: {
          managed: {
            codeLocation: "app/answer_faithfulness",
            entrypoint: "lambda_function.handler",
            timeoutSeconds: 300,
            additionalPolicies: ["execution-role-policy.json"],
          },
        },
      },
    });

    const appDir = join(projectRoot, "app", "answer_faithfulness");
    const handler = await Bun.file(join(appDir, "lambda_function.py")).text();
    expect(handler).toContain("FaithfulnessMetric");
    expect(handler).toContain("AmazonBedrockModel");
    expect(handler).toContain("anthropic.claude-3-5-sonnet-20240620-v1:0");
    expect(await Bun.file(join(appDir, "execution-role-policy.json")).exists()).toBe(true);
    expect(handler).not.toContain("{{");
  });

  test("autoevals metric with default (non-bedrock) model", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "factuality",
      "--level",
      "TRACE",
      "--metric",
      "autoevals.Factuality",
    ]);

    expect(
      (await evaluator(projectRoot, "factuality")).config.codeBased.managed.timeoutSeconds,
    ).toBe(60);
    const handler = await Bun.file(
      join(projectRoot, "app", "factuality", "lambda_function.py"),
    ).text();
    expect(handler).toContain("Factuality");
    expect(handler).not.toContain("{{");
  });

  test("no metric, no lambda → empty managed stub", async () => {
    const projectRoot = await inProject();
    await run(["add", "evaluator", "code-based", "--name", "custom_eval", "--level", "TOOL_CALL"]);

    expect((await evaluator(projectRoot, "custom_eval")).config.codeBased.managed).toMatchObject({
      codeLocation: "app/custom_eval",
      timeoutSeconds: 60,
    });
    const handler = await Bun.file(
      join(projectRoot, "app", "custom_eval", "lambda_function.py"),
    ).text();
    expect(handler).toContain("TODO");
    expect(handler).toContain("custom_code_based_evaluator");
  });

  test("--lambda-arn → external config, no scaffold", async () => {
    const projectRoot = await inProject();
    const arn = "arn:aws:lambda:us-west-2:123456789012:function:refund-policy";
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "refund_policy",
      "--level",
      "SESSION",
      "--lambda-arn",
      arn,
    ]);

    expect((await evaluator(projectRoot, "refund_policy")).config).toEqual({
      codeBased: { external: { lambdaArn: arn } },
    });
    expect(
      await Bun.file(join(projectRoot, "app", "refund_policy", "lambda_function.py")).exists(),
    ).toBe(false);
  });

  test("persists description, kms key, and tags", async () => {
    const projectRoot = await inProject();
    const kms = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "full",
      "--level",
      "SESSION",
      "--lambda-arn",
      "arn:aws:lambda:us-west-2:123456789012:function:f",
      "--description",
      "external scorer",
      "--kms-key-arn",
      kms,
      "--tags",
      '{"team":"ml"}',
    ]);

    expect(await evaluator(projectRoot, "full")).toMatchObject({
      description: "external scorer",
      kmsKeyArn: kms,
      tags: { team: "ml" },
    });
  });

  test.each<[string, string[]]>([
    ["missing --name", ["--level", "SESSION"]],
    ["missing --level", ["--name", "x"]],
    [
      "--metric and --lambda-arn together",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--metric",
        "deepeval.FaithfulnessMetric",
        "--lambda-arn",
        "arn:aws:lambda:us-west-2:123456789012:function:f",
      ],
    ],
    [
      "unknown metric library",
      ["--name", "x", "--level", "SESSION", "--metric", "ragas.Faithfulness"],
    ],
    ["metric without a class", ["--name", "x", "--level", "SESSION", "--metric", "deepeval"]],
    [
      "namespaced (multi-dot) metric class",
      ["--name", "x", "--level", "SESSION", "--metric", "deepeval.metrics.Faithfulness"],
    ],
    [
      "non-Bedrock --model",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--metric",
        "deepeval.FaithfulnessMetric",
        "--model",
        "gpt-4o",
      ],
    ],
    [
      "--model bedrock with no slash/id",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--metric",
        "autoevals.Factuality",
        "--model",
        "bedrock",
      ],
    ],
    ["--model without --metric", ["--name", "x", "--level", "SESSION", "--model", "bedrock/foo"]],
    [
      "managed flag with --lambda-arn",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--lambda-arn",
        "arn:aws:lambda:us-west-2:123456789012:function:f",
        "--timeout-seconds",
        "30",
      ],
    ],
    ["invalid --level", ["--name", "x", "--level", "NOPE"]],
    ["invalid --lambda-arn", ["--name", "x", "--level", "SESSION", "--lambda-arn", "not-an-arn"]],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "evaluator", "code-based", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test("accepts a bare Bedrock inference-profile model id and renders it into the source", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "prof",
      "--level",
      "SESSION",
      "--metric",
      "deepeval.FaithfulnessMetric",
      "--model",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]);
    expect(await evaluator(projectRoot, "prof")).toBeDefined();
    const src = await Bun.file(join(projectRoot, "app", "prof", "lambda_function.py")).text();
    expect(src).toContain("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  test("rejects a duplicate evaluator name", async () => {
    await inProject();
    const flags = [
      "add",
      "evaluator",
      "code-based",
      "--name",
      "dup",
      "--level",
      "SESSION",
      "--lambda-arn",
      "arn:aws:lambda:us-west-2:123456789012:function:f",
    ];
    await run(flags);
    await expect(run(flags)).rejects.toBeInstanceOf(InputValidationError);
  });

  test("errors before writing when app/<name> already exists (cross-resource collision)", async () => {
    const projectRoot = await inProject();
    const appDir = join(projectRoot, "app", "collide");
    await mkdir(appDir, { recursive: true });
    await Bun.write(join(appDir, "pyproject.toml"), "# pre-existing\n");

    await expect(
      run(["add", "evaluator", "code-based", "--name", "collide", "--level", "SESSION"]),
    ).rejects.toBeInstanceOf(InputValidationError);

    expect(await evaluator(projectRoot, "collide")).toBeUndefined();
    expect(await Bun.file(join(appDir, "pyproject.toml")).text()).toBe("# pre-existing\n");
    expect(await Bun.file(join(appDir, "lambda_function.py")).exists()).toBe(false);
  });

  test("empty stub warns it returns Pass until implemented", async () => {
    await inProject();
    const { io } = await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "stub",
      "--level",
      "SESSION",
    ]);
    expect(io.stderr()).toContain("returns Pass for every session");
  });

  test("external mode prints no stub note", async () => {
    await inProject();
    const { io } = await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "ext",
      "--level",
      "SESSION",
      "--lambda-arn",
      "arn:aws:lambda:us-west-2:123456789012:function:f",
    ]);
    expect(io.stderr()).not.toContain("returns Pass for every session");
  });

  test("remove evaluator drops it from the spec", async () => {
    const projectRoot = await inProject();
    await run(["add", "evaluator", "code-based", "--name", "gone", "--level", "SESSION"]);
    expect(await evaluator(projectRoot, "gone")).toBeDefined();
    await run(["remove", "evaluator", "--name", "gone"]);
    expect(await evaluator(projectRoot, "gone")).toBeUndefined();
  });
});
