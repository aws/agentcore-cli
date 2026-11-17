import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetDatasetGenerationResponse,
  StartDatasetGenerationResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSilentLogger,
  expectError,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { InputValidationError } from "../../../errors";
import { createRootHandler } from "../../index";
import type { StartDatasetGenerationInput } from "../types";

const REGION = "us-west-2";
const DATASET_ID = "checkout_flows-a1B2c3D4e5";
const GENERATION_ID = "golden_mining-k3L9mQ2xZa";
const CONFIG = {
  sourceConfig: {
    batchEvaluation: {
      batchEvaluationArn:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:batch-evaluate/nightly-a1b2c3d4e5",
    },
  },
  sampling: { maxScenarios: 50 },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function writeTempConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-dataset-generation-"));
  dirs.push(dir);
  const path = join(dir, "generation.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function testGenerationCommand(stdin?: string, isTTY = false) {
  const core = new TestCoreClient();
  const io = testIO({ isTTY });
  if (stdin !== undefined) {
    io.io.stdin.push(stdin);
    io.io.stdin.push(null);
  }
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  return {
    root,
    core,
    stdout: io.stdout,
    stderr: io.stderr,
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
  };
}

function startInput(core: TestCoreClient): StartDatasetGenerationInput {
  const call = core.eval.calls.find((c) => c.method === "startDatasetGeneration");
  if (!call) throw new Error("startDatasetGeneration was not called");
  return call.args[0] as StartDatasetGenerationInput;
}

const START = ["eval", "dataset-generation", "start", "--dataset-id", DATASET_ID, "--name", "g1"];

describe("eval dataset-generation command hierarchy", () => {
  test("mounts dataset-generation beside dataset with its four leaves", () => {
    const { root } = testGenerationCommand();
    const evalRouter = root.children().find((c) => c.name() === "eval");
    const names = evalRouter?.children().map((c) => c.name()) ?? [];

    expect(names.indexOf("dataset-generation")).toBe(names.indexOf("dataset") + 1);
    expect(
      evalRouter
        ?.children()
        .find((c) => c.name() === "dataset-generation")
        ?.children()
        .map((c) => c.name()),
    ).toEqual(["start", "get", "list", "delete"]);
  });

  // The group ships headless, so a bare invocation must print help rather than
  // launch the TUI.
  test("prints help for bare `eval dataset-generation` without calling the service", async () => {
    const { core, stdout, route } = testGenerationCommand();

    await route(["eval", "dataset-generation"]);

    expect(stdout()).toContain("Usage: agentcore eval dataset-generation");
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("dataset-generation start", () => {
  test("sends the config document as the trace generation source", async () => {
    const { core, route } = testGenerationCommand();

    await route([...START, "--generation-config", `file://${writeTempConfig(CONFIG)}`]);

    expect(startInput(core)).toEqual({
      datasetId: DATASET_ID,
      name: "g1",
      description: undefined,
      scenarioType: undefined,
      source: { traceGeneration: CONFIG },
    });
  });

  test("leaves scenarioType to the service when --scenario-type is absent", async () => {
    const { core, route } = testGenerationCommand();

    await route([...START, "--generation-config", JSON.stringify(CONFIG)]);

    expect(startInput(core).scenarioType).toBeUndefined();
  });

  test.each([
    ["fixed", "FIXED"],
    ["dynamic", "DYNAMIC"],
  ] as const)("maps --scenario-type %s to %s", async (alias, expected) => {
    const { core, route } = testGenerationCommand();

    await route([
      ...START,
      "--scenario-type",
      alias,
      "--generation-config",
      JSON.stringify(CONFIG),
    ]);

    expect(startInput(core).scenarioType).toBe(expected);
  });

  test("reads the config document from stdin", async () => {
    const { core, route } = testGenerationCommand(JSON.stringify(CONFIG));

    await route([...START, "--generation-config", "-"]);

    expect(startInput(core).source).toEqual({ traceGeneration: CONFIG });
  });

  test("renders the service response as JSON", async () => {
    const { core, stdout, route } = testGenerationCommand();
    const response = {
      generationId: GENERATION_ID,
      name: "golden_mining",
      datasetId: DATASET_ID,
      status: "IN_PROGRESS",
    } as unknown as StartDatasetGenerationResponse;
    core.eval.setStartDatasetGenerationResponse(response);

    await route([...START, "--generation-config", JSON.stringify(CONFIG)]);

    expect(JSON.parse(stdout())).toEqual(response);
  });

  test("accepts --scenario-type in the service's upper case", async () => {
    const { core, route } = testGenerationCommand();

    await route([
      ...START,
      "--scenario-type",
      "FIXED",
      "--generation-config",
      JSON.stringify(CONFIG),
    ]);

    expect(startInput(core).scenarioType).toBe("FIXED");
  });

  test("passes every documented config key through", async () => {
    const { core, route } = testGenerationCommand();
    const full = {
      sourceConfig: {
        cloudWatchLogs: {
          logGroupNames: ["/aws/agent"],
          serviceNames: ["agent"],
          startTime: "2026-11-10T00:00:00Z",
          endTime: "2026-11-11T00:00:00Z",
        },
      },
      selection: {
        filters: {
          attributeFilters: [
            { key: "attributes.x", operator: "Equals", value: { stringValue: "y" } },
          ],
          turnCount: { min: 1, max: 10 },
        },
      },
      sampling: { maxScenarios: 5 },
      groundTruth: { fields: ["expected_response"] },
      redactionConfiguration: { identifiers: ["EMAIL_ADDRESS"], customDataIdentifiers: [] },
    };

    await route([...START, "--generation-config", JSON.stringify(full)]);

    // Compared as plain JSON: the CLI forwards the document as parsed, not as SDK-typed values.
    expect(startInput(core).source as unknown).toEqual({ traceGeneration: full });
  });

  // The SDK drops keys it does not model, so a misspelling would otherwise run with defaults:
  // a typo in redactionConfiguration silently disables redaction.
  test.each([
    [
      { ...CONFIG, redactionConfig: { identifiers: ["EMAIL_ADDRESS"] } },
      "'redactionConfig'",
      "'redactionConfiguration'",
    ],
    [
      { ...CONFIG, sampling: { maxScenario: 2 } },
      "'sampling.maxScenario'",
      "'sampling.maxScenarios'",
    ],
    [{ sourceconfig: CONFIG.sourceConfig }, "'sourceconfig'", "'sourceConfig'"],
  ])("rejects a misspelled config key and suggests the right one", async (config, bad, good) => {
    const { core, route } = testGenerationCommand();

    const promise = route([...START, "--generation-config", JSON.stringify(config)]);

    await expectError(promise, new RegExp(`${bad}.*did you mean ${good}`), InputValidationError);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("rejects the design-era filterConfig key", async () => {
    const { core, route } = testGenerationCommand();

    const promise = route([
      ...START,
      "--generation-config",
      JSON.stringify({ ...CONFIG, filterConfig: { sessionIds: ["s1"] } }),
    ]);

    await expectError(
      promise,
      /Unknown key 'filterConfig'.*Known keys here: sourceConfig, selection/,
      InputValidationError,
    );
    expect(core.eval.calls).toHaveLength(0);
  });

  test("tells a terminal user that '-' is reading stdin", async () => {
    const { core, route, stderr } = testGenerationCommand(JSON.stringify(CONFIG), true);

    await route([...START, "--generation-config", "-"]);

    expect(stderr()).toContain(
      "Reading --generation-config JSON from stdin; press Ctrl-D when done.",
    );
    expect(startInput(core).source).toEqual({ traceGeneration: CONFIG });
  });

  test("stays quiet when '-' reads piped stdin", async () => {
    const { route, stderr } = testGenerationCommand(JSON.stringify(CONFIG));

    await route([...START, "--generation-config", "-"]);

    expect(stderr()).not.toContain("Reading --generation-config");
  });

  describe("input validation", () => {
    test("rejects an unknown --scenario-type", async () => {
      const { core, route } = testGenerationCommand();

      const promise = route([
        ...START,
        "--scenario-type",
        "predefined",
        "--generation-config",
        JSON.stringify(CONFIG),
      ]);

      await expectError(promise, /--scenario-type/, InputValidationError);
      expect(core.eval.calls).toHaveLength(0);
    });

    test("requires --generation-config", async () => {
      const { core, route } = testGenerationCommand();

      await expectError(route(START), /--generation-config/, InputValidationError);
      expect(core.eval.calls).toHaveLength(0);
    });

    test("rejects a config that is not a JSON object", async () => {
      const { core, route } = testGenerationCommand();

      const promise = route([...START, "--generation-config", "[1,2]"]);

      await expectError(
        promise,
        "Option '--generation-config' must be a JSON object",
        InputValidationError,
      );
      expect(core.eval.calls).toHaveLength(0);
    });
  });
});

describe("dataset-generation get", () => {
  test("gets the generation under its dataset and prints it", async () => {
    const { core, stdout, route } = testGenerationCommand();
    const response = {
      generationId: GENERATION_ID,
      status: "COMPLETED",
    } as unknown as GetDatasetGenerationResponse;
    core.eval.setGetDatasetGenerationResponse(response);

    await route([
      "eval",
      "dataset-generation",
      "get",
      "--dataset-id",
      DATASET_ID,
      "--id",
      GENERATION_ID,
    ]);

    expect(core.eval.calls[0]?.args.slice(0, 2)).toEqual([DATASET_ID, GENERATION_ID]);
    expect(JSON.parse(stdout())).toEqual(response);
  });

  test("requires --dataset-id", async () => {
    const { route } = testGenerationCommand();

    await expectError(
      route(["eval", "dataset-generation", "get", "--id", GENERATION_ID]),
      /--dataset-id/,
      InputValidationError,
    );
  });
});

describe("dataset-generation list", () => {
  test("lists without pagination flags", async () => {
    const { core, route } = testGenerationCommand();

    await route(["eval", "dataset-generation", "list", "--dataset-id", DATASET_ID]);

    expect(core.eval.calls[0]?.args.slice(0, 3)).toEqual([DATASET_ID, undefined, undefined]);
  });

  test("paginates with --max-results and --next-token", async () => {
    const { core, route } = testGenerationCommand();

    await route([
      "eval",
      "dataset-generation",
      "list",
      "--dataset-id",
      DATASET_ID,
      "--max-results",
      "5",
      "--next-token",
      "page-2",
    ]);

    expect(core.eval.calls[0]?.args.slice(0, 3)).toEqual([DATASET_ID, "page-2", 5]);
  });
});

describe("dataset-generation list bounds", () => {
  test.each([["0"], ["101"], ["0.5"]])(
    "rejects --max-results %s before calling the service",
    async (n) => {
      const { core, route } = testGenerationCommand();

      const promise = route([
        "eval",
        "dataset-generation",
        "list",
        "--dataset-id",
        DATASET_ID,
        "--max-results",
        n,
      ]);

      await expectError(promise, /--max-results/, InputValidationError);
      expect(core.eval.calls).toHaveLength(0);
    },
  );
});

describe("dataset-generation delete", () => {
  test("deletes the generation record under its dataset", async () => {
    const { core, route } = testGenerationCommand();

    await route([
      "eval",
      "dataset-generation",
      "delete",
      "--dataset-id",
      DATASET_ID,
      "--id",
      GENERATION_ID,
    ]);

    expect(core.eval.calls[0]?.method).toBe("deleteDatasetGeneration");
    expect(core.eval.calls[0]?.args.slice(0, 2)).toEqual([DATASET_ID, GENERATION_ID]);
  });
});
