import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRootHandler } from "../../../../index";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../../testing";
import { InputValidationError } from "../../../../../errors";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

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

const spec = (projectRoot: string) =>
  Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
const evaluator = async (projectRoot: string, name: string) =>
  ((await spec(projectRoot)).evaluators ?? []).find((e: { name: string }) => e.name === name);

describe("project add evaluator code-based", () => {
  test("scaffolds managed evaluator code with an explicit timeout", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "answer_faithfulness",
      "--level",
      "SESSION",
      "--timeout-seconds",
      "120",
    ]);

    expect(await evaluator(projectRoot, "answer_faithfulness")).toMatchObject({
      name: "answer_faithfulness",
      level: "SESSION",
      config: {
        codeBased: {
          managed: {
            codeLocation: "app/answer_faithfulness",
            entrypoint: "lambda_function.handler",
            timeoutSeconds: 120,
            additionalPolicies: ["execution-role-policy.json"],
          },
        },
      },
    });

    const appDir = join(projectRoot, "app", "answer_faithfulness");
    const handler = await Bun.file(join(appDir, "lambda_function.py")).text();
    expect(handler).toContain("TODO");
    expect(handler).toContain("custom_code_based_evaluator");
    expect(await Bun.file(join(appDir, "README.md")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "pyproject.toml")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "execution-role-policy.json")).exists()).toBe(true);
    expect(handler).not.toContain("{{");
  });

  test("no lambda → managed stub with the default timeout", async () => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
      "--timeout-seconds with --lambda-arn",
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
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(run(["add", "evaluator", "code-based", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test.each([
    ["--metric", "deepeval.FaithfulnessMetric"],
    ["--model", "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0"],
  ])("rejects removed %s before writing", async (removedFlag, value) => {
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await expect(
      run([
        "add",
        "evaluator",
        "code-based",
        "--name",
        "removed",
        "--level",
        "SESSION",
        removedFlag,
        value,
      ]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });

    expect(await evaluator(projectRoot, "removed")).toBeUndefined();
    expect(await Bun.file(join(projectRoot, "app", "removed")).exists()).toBe(false);
  });

  test("rejects a duplicate evaluator name", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
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

  test("--json reports the empty stub guidance as a structured note", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
    const { io } = await run([
      "add",
      "evaluator",
      "code-based",
      "--name",
      "stub",
      "--level",
      "SESSION",
      "--json",
    ]);

    expect(JSON.parse(io.stdout()).notes).toEqual([
      "note: this evaluator returns Pass for every session until you implement app/stub/lambda_function.py",
    ]);
    expect(io.stderr()).not.toContain("returns Pass for every session");
  });

  test("external mode prints no stub note", async () => {
    const { cleanup } = await initProject();
    cleanups.push(cleanup);
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
    const { projectRoot, cleanup } = await initProject();
    cleanups.push(cleanup);
    await run(["add", "evaluator", "code-based", "--name", "gone", "--level", "SESSION"]);
    expect(await evaluator(projectRoot, "gone")).toBeDefined();
    await run(["remove", "evaluator", "--name", "gone"]);
    expect(await evaluator(projectRoot, "gone")).toBeUndefined();
  });
});
