import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../../testing";
import { DeserializationError, InputValidationError } from "../../../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-evaluator-"));
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

async function run(args: string[], opts?: { core?: TestCoreClient }) {
  const io = testIO();
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

const MODEL = "anthropic.claude-3-5-sonnet-20240620-v1:0";

describe("project add evaluator llm-as-a-judge", () => {
  test("writes a numerical preset evaluator into the spec", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "quality",
      "--level",
      "SESSION",
      "--model",
      MODEL,
      "--instructions",
      "Score the helpfulness of the response.",
      "--rating-scale",
      "1-5-quality",
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const evaluator = spec.evaluators.find((e: { name: string }) => e.name === "quality");
    expect(evaluator).toMatchObject({
      name: "quality",
      level: "SESSION",
      config: {
        llmAsAJudge: {
          model: MODEL,
          instructions: "Score the helpfulness of the response.",
        },
      },
    });
    expect(evaluator.config.llmAsAJudge.ratingScale.numerical).toHaveLength(5);
    expect(evaluator.config.llmAsAJudge.ratingScale.categorical).toBeUndefined();
  });

  test("writes a categorical preset evaluator", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "gate",
      "--level",
      "TRACE",
      "--model",
      MODEL,
      "--instructions",
      "Pass if the answer is grounded.",
      "--rating-scale",
      "pass-fail",
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const evaluator = spec.evaluators.find((e: { name: string }) => e.name === "gate");
    expect(evaluator.config.llmAsAJudge.ratingScale.categorical).toEqual([
      { label: "pass", definition: "The response meets the evaluation criteria." },
      { label: "fail", definition: "The response does not meet the evaluation criteria." },
    ]);
  });

  test("reads instructions from a file:// source", async () => {
    const projectRoot = await inProject();
    const instructionsPath = join(projectRoot, "instructions.txt");
    await writeFile(instructionsPath, "Evaluate factual accuracy.\n");

    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "accuracy",
      "--level",
      "TOOL_CALL",
      "--model",
      MODEL,
      "--instructions",
      `file://${instructionsPath}`,
      "--rating-scale",
      "1-3-simple",
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const evaluator = spec.evaluators.find((e: { name: string }) => e.name === "accuracy");
    expect(evaluator.config.llmAsAJudge.instructions).toBe("Evaluate factual accuracy.\n");
  });

  test("accepts an inline JSON rating scale on --rating-scale", async () => {
    const projectRoot = await inProject();

    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "custom",
      "--level",
      "SESSION",
      "--model",
      MODEL,
      "--instructions",
      "Judge the answer.",
      "--rating-scale",
      JSON.stringify({
        categorical: [
          { label: "yes", definition: "Meets the bar." },
          { label: "no", definition: "Does not." },
        ],
      }),
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const evaluator = spec.evaluators.find((e: { name: string }) => e.name === "custom");
    expect(evaluator.config.llmAsAJudge.ratingScale.categorical).toEqual([
      { label: "yes", definition: "Meets the bar." },
      { label: "no", definition: "Does not." },
    ]);
  });

  test("persists description, kms key, and tags", async () => {
    const projectRoot = await inProject();
    const kms = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
    await run([
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "full",
      "--level",
      "SESSION",
      "--model",
      MODEL,
      "--instructions",
      "Judge the answer.",
      "--rating-scale",
      "pass-fail",
      "--description",
      "gate on grounding",
      "--kms-key-arn",
      kms,
      "--tags",
      '{"team":"ml"}',
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const evaluator = spec.evaluators.find((e: { name: string }) => e.name === "full");
    expect(evaluator).toMatchObject({
      description: "gate on grounding",
      kmsKeyArn: kms,
      tags: { team: "ml" },
    });
  });

  test("rejects a duplicate evaluator name", async () => {
    await inProject();
    const flags = [
      "add",
      "evaluator",
      "llm-as-a-judge",
      "--name",
      "dup",
      "--level",
      "SESSION",
      "--model",
      MODEL,
      "--instructions",
      "Judge the answer.",
      "--rating-scale",
      "pass-fail",
    ];
    await run(flags);
    await expect(run(flags)).rejects.toBeInstanceOf(InputValidationError);
  });

  test("rejects when the existing spec is invalid", async () => {
    const projectRoot = await inProject();
    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const spec = await Bun.file(specPath).json();
    spec.unknownField = "bad";
    await Bun.write(specPath, JSON.stringify(spec));

    await expect(
      run([
        "add",
        "evaluator",
        "llm-as-a-judge",
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        MODEL,
        "--instructions",
        "Judge the answer.",
        "--rating-scale",
        "pass-fail",
      ]),
    ).rejects.toBeInstanceOf(DeserializationError);
  });

  test.each<[string, string[]]>([
    [
      "missing --name",
      [
        "--level",
        "SESSION",
        "--model",
        MODEL,
        "--instructions",
        "i",
        "--rating-scale",
        "pass-fail",
      ],
    ],
    [
      "missing --level",
      ["--name", "x", "--model", MODEL, "--instructions", "i", "--rating-scale", "pass-fail"],
    ],
    [
      "missing --model",
      ["--name", "x", "--level", "SESSION", "--instructions", "i", "--rating-scale", "pass-fail"],
    ],
    [
      "missing --instructions",
      ["--name", "x", "--level", "SESSION", "--model", MODEL, "--rating-scale", "pass-fail"],
    ],
    [
      "invalid --model",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        "not a model",
        "--instructions",
        "i",
        "--rating-scale",
        "pass-fail",
      ],
    ],
    [
      "invalid --level",
      [
        "--name",
        "x",
        "--level",
        "NOPE",
        "--model",
        MODEL,
        "--instructions",
        "i",
        "--rating-scale",
        "pass-fail",
      ],
    ],
    [
      "--rating-scale is neither a preset nor JSON",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        MODEL,
        "--instructions",
        "i",
        "--rating-scale",
        "bogus",
      ],
    ],
    [
      "--rating-scale inline JSON fails the schema",
      [
        "--name",
        "x",
        "--level",
        "SESSION",
        "--model",
        MODEL,
        "--instructions",
        "i",
        "--rating-scale",
        '{"numerical":[],"categorical":[]}',
      ],
    ],
    [
      "no rating scale",
      ["--name", "x", "--level", "SESSION", "--model", MODEL, "--instructions", "i"],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "evaluator", "llm-as-a-judge", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
