import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CoreClient } from "../../../core";
import {
  createSilentLogger,
  fixtureFactories,
  matchGolden,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";
import { ratingScaleFromPreset } from "../ratingScale";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");

// Record with RECORD=1 bun test src/handlers/eval/evaluator/evaluator.test.tsx
// The RECORD run creates one evaluator of each type, exercises get/list/update
// against them, then deletes both, so a recording leaves no residue. The ids the
// service assigns are captured from the recorded create responses, which keeps
// the dependent fixtures (keyed by request input) stable on replay.
const LLAJ_NAME = "agentcore_cli_eval_fixture_llaj";
const CODE_BASED_NAME = "agentcore_cli_eval_fixture_code";
// Evaluator ids must match `[a-zA-Z][a-zA-Z0-9-_]{0,99}-[a-zA-Z0-9]{10}`. An id that
// fails the pattern is rejected as a ValidationException before any lookup happens,
// so this one is well-formed and simply absent, to reach the not-found path.
const MISSING_EVALUATOR_ID = "missing-eval-0000000000";

// CreateEvaluator validates that the Lambda exists, so recording needs a real
// function in the fixture account. It is only referenced, never invoked.
const FIXTURE_LAMBDA_ARN =
  "arn:aws:lambda:us-west-2:685197708687:function:agentcore-bugbash-echo-1774451937";

// SESSION-level instructions must reference at least one allowed placeholder
// (context, available_tools, assertions, ...), so the recorded input uses {context}.
const FIXTURE_INSTRUCTIONS =
  "Judge from {context} whether the agent resolved the customer's request.";

// The inference tuning seeded on the "tuned" evaluator. `--model` only carries a
// model id, so the CLI cannot set inferenceConfig; it is seeded through the SDK
// during recording purely to prove an update preserves it. temperature and topP
// are mutually exclusive on this model, so only temperature is set.
const TUNED_NAME = "agentcore_cli_eval_fixture_tuned";
const TUNED_INFERENCE_CONFIG = { temperature: 0, maxTokens: 512 };

function createFixtureCore(): CoreClient {
  const { createControlClient, createDataClient, createIamClient } = fixtureFactories(FIXTURES);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    logger: createSilentLogger(),
  });
}

// run drives the real router (parsing → middleware → handler → CoreClient) against
// the fixture-backed SDK clients and returns captured stdout. Optional `stdin`
// seeds the in-memory input stream so `-` sources can be exercised.
async function run(args: string[], stdin?: string): Promise<string> {
  const io = testIO();
  if (stdin !== undefined) {
    io.io.stdin.push(stdin);
    io.io.stdin.push(null);
  }
  const root = createRootHandler(createFixtureCore(), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

// The ids assigned by CreateEvaluator, shared by the get/update/delete tests below.
let llajId: string;
let codeBasedId: string;
let tunedId: string;

// seedTunedEvaluator creates an evaluator carrying an inferenceConfig, which no
// CLI flag can express, so the preservation test has something to preserve. It
// runs against the live API in record mode only; on replay the id comes from the
// recorded fixture below.
async function seedTunedEvaluator(): Promise<string> {
  const response = await createFixtureCore().eval.createEvaluator(
    {
      evaluatorName: TUNED_NAME,
      level: "SESSION",
      evaluatorConfig: {
        llmAsAJudge: {
          instructions: FIXTURE_INSTRUCTIONS,
          ratingScale: ratingScaleFromPreset("1-5-quality"),
          modelConfig: {
            bedrockEvaluatorModelConfig: {
              modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
              inferenceConfig: TUNED_INFERENCE_CONFIG,
            },
          },
        },
      },
    },
    { region: REGION, endpointUrl: undefined },
  );
  if (!response.evaluatorId) throw new Error("seeding the tuned evaluator returned no id");
  return response.evaluatorId;
}

describe("eval command hierarchy", () => {
  test("registers the eval → evaluator command tree", () => {
    const root = createRootHandler(createFixtureCore(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
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
    const stdout = await run(command.split(" "));
    expect(stdout).toContain(`Usage: agentcore ${command}`);
    expect(stdout).toContain("Commands:");
  });
});

describe("evaluator CRUDL", () => {
  test("creates an LLM-as-a-Judge evaluator", async () => {
    const stdout = await run([
      "eval",
      "evaluator",
      "llm-as-a-judge",
      "create",
      "--name",
      LLAJ_NAME,
      "--level",
      "SESSION",
      "--model",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "--instructions",
      FIXTURE_INSTRUCTIONS,
      "--rating-scale",
      "1-5-quality",
    ]);

    matchGolden(FIXTURES, "llaj-create.golden.json", stdout);
    llajId = JSON.parse(stdout).evaluatorId;
    expect(llajId).toBeString();
  });

  test("creates a code-based evaluator", async () => {
    const stdout = await run([
      "eval",
      "evaluator",
      "code-based",
      "create",
      "--name",
      CODE_BASED_NAME,
      "--level",
      "SESSION",
      "--lambda-arn",
      FIXTURE_LAMBDA_ARN,
      "--timeout",
      "30",
    ]);

    matchGolden(FIXTURES, "code-based-create.golden.json", stdout);
    codeBasedId = JSON.parse(stdout).evaluatorId;
    expect(codeBasedId).toBeString();
  });

  test("lists evaluators", async () => {
    const stdout = await run(["eval", "evaluator", "list"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).evaluators).toBeArray();
  });

  test("paginates the evaluator list with --max-results and --next-token", async () => {
    const firstPage = await run(["eval", "evaluator", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.evaluators).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "eval",
      "evaluator",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).evaluators).toHaveLength(1);
  });

  // The update handlers merge over the current config because UpdateEvaluator
  // replaces the whole evaluatorConfig union; these assert the unset fields
  // survive the round trip.
  test("updates only the model on an LLM-as-a-Judge evaluator, preserving the rest", async () => {
    const stdout = await run([
      "eval",
      "evaluator",
      "llm-as-a-judge",
      "update",
      "--id",
      llajId,
      "--model",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ]);

    matchGolden(FIXTURES, "llaj-update.golden.json", stdout);

    // `get` is asserted here rather than in its own test: fixtures are keyed by
    // request input, so a second `get` of this id would share (and disagree with)
    // this one's recording.
    const getStdout = await run(["eval", "evaluator", "get", "--id", llajId]);
    matchGolden(FIXTURES, "get.golden.json", getStdout);

    const after = JSON.parse(getStdout);
    expect(after.evaluatorName).toBe(LLAJ_NAME);
    const llaj = after.evaluatorConfig.llmAsAJudge;
    expect(llaj.modelConfig.bedrockEvaluatorModelConfig.modelId).toContain("haiku");
    expect(llaj.instructions).toBe(FIXTURE_INSTRUCTIONS);
    expect(llaj.ratingScale).toEqual(ratingScaleFromPreset("1-5-quality"));
  });

  // Regression: the update used to rebuild bedrockEvaluatorModelConfig from
  // modelId alone, which silently dropped inferenceConfig and
  // additionalModelRequestFields. An update that never mentions the model must
  // leave the tuning intact.
  test("updates instructions without dropping the existing inferenceConfig", async () => {
    tunedId = await seedTunedEvaluator();

    const before = JSON.parse(await run(["eval", "evaluator", "get", "--id", tunedId]));
    expect(
      before.evaluatorConfig.llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig.inferenceConfig,
    ).toEqual(TUNED_INFERENCE_CONFIG);

    await run([
      "eval",
      "evaluator",
      "llm-as-a-judge",
      "update",
      "--id",
      tunedId,
      "--instructions",
      "Judge from {context} whether the agent was both correct and polite.",
    ]);

    const model = JSON.parse(await run(["eval", "evaluator", "get", "--id", tunedId]))
      .evaluatorConfig.llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig;
    expect(model.inferenceConfig).toEqual(TUNED_INFERENCE_CONFIG);
    expect(model.modelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  test("deletes the tuned evaluator", async () => {
    await run(["eval", "evaluator", "delete", "--id", tunedId]);
  });

  test("updates only the timeout on a code-based evaluator, preserving the Lambda ARN", async () => {
    const stdout = await run([
      "eval",
      "evaluator",
      "code-based",
      "update",
      "--id",
      codeBasedId,
      "--timeout",
      "45",
    ]);

    matchGolden(FIXTURES, "code-based-update.golden.json", stdout);

    const after = JSON.parse(await run(["eval", "evaluator", "get", "--id", codeBasedId]));
    const lambdaConfig = after.evaluatorConfig.codeBased.lambdaConfig;
    expect(lambdaConfig.lambdaArn).toBe(FIXTURE_LAMBDA_ARN);
    expect(lambdaConfig.lambdaTimeoutInSeconds).toBe(45);
  });

  test("rejects updating an evaluator through the wrong type's command", async () => {
    await expect(
      run(["eval", "evaluator", "code-based", "update", "--id", llajId, "--timeout", "60"]),
    ).rejects.toThrow(/is not a code-based evaluator/);

    await expect(
      run(["eval", "evaluator", "llm-as-a-judge", "update", "--id", codeBasedId, "--model", "m"]),
    ).rejects.toThrow(/is not an LLM-as-a-Judge evaluator/);
  });

  test("deletes the LLM-as-a-Judge evaluator", async () => {
    const stdout = await run(["eval", "evaluator", "delete", "--id", llajId]);
    matchGolden(FIXTURES, "llaj-delete.golden.json", stdout);
  });

  test("deletes the code-based evaluator", async () => {
    const stdout = await run(["eval", "evaluator", "delete", "--id", codeBasedId]);
    matchGolden(FIXTURES, "code-based-delete.golden.json", stdout);
  });

  test("propagates ResourceNotFoundException from get", async () => {
    await expect(
      run(["eval", "evaluator", "get", "--id", MISSING_EVALUATOR_ID]),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});

// Flag parsing and source resolution never reach the SDK, so these need no fixtures.
describe("evaluator flag validation", () => {
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
      "missing --rating-scale",
      ["--name", "x", "--level", "SESSION", "--model", "m", "--instructions", "i"],
      /rating-scale/,
    ],
  ] as const)("llm-as-a-judge create rejects %s", async (_label, extra, message) => {
    await expect(run(["eval", "evaluator", "llm-as-a-judge", "create", ...extra])).rejects.toThrow(
      message,
    );
  });

  test("code-based create rejects a missing --lambda-arn", async () => {
    await expect(
      run(["eval", "evaluator", "code-based", "create", "--name", "x", "--level", "SESSION"]),
    ).rejects.toThrow(/--lambda-arn/);
  });

  test.each([
    ["llm-as-a-judge update", ["eval", "evaluator", "llm-as-a-judge", "update"]],
    ["code-based update", ["eval", "evaluator", "code-based", "update"]],
    ["get", ["eval", "evaluator", "get"]],
    ["delete", ["eval", "evaluator", "delete"]],
  ] as const)("`%s` requires --id", async (_label, args) => {
    await expect(run([...args])).rejects.toThrow(/--id/);
  });

  test("rejects malformed custom rating scale JSON", async () => {
    await expect(
      run([
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
        "{not json",
      ]),
    ).rejects.toThrow(/Invalid JSON for option '--rating-scale'/);
  });
});
