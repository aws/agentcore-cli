import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";
import type { CreateDatasetInput } from "../types";

const REGION = "us-west-2";

const EXAMPLE_A = { scenario_id: "shipped-order", turns: [{ input: "Where is order 12345?" }] };
const EXAMPLE_B = { scenario_id: "unknown-order", turns: [{ input: "Where is order 99999?" }] };

function writeTempJsonl(...examples: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentcore-dataset-")), "orders.jsonl");
  writeFileSync(path, `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

// testDatasetCommand drives the real router (parsing → middleware → handler)
// against a controllable Core, so the assertions below cover how flags translate
// into the CreateDataset request rather than what the service returns.
function testDatasetCommand(stdin?: string) {
  const core = new TestCoreClient();
  const io = testIO();
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
    core,
    stdout: io.stdout,
    route: (args: string[]) => root.route(["node", "agentcore", ...args, "--region", REGION]),
  };
}

// createDatasetInput returns the input the handler passed to Core, failing the
// test if it never called through.
function createDatasetInput(core: TestCoreClient): CreateDatasetInput {
  const call = core.eval.calls.find((c) => c.method === "createDataset");
  if (!call) throw new Error("createDataset was not called");
  return call.args[0] as CreateDatasetInput;
}

describe("eval dataset command hierarchy", () => {
  test("registers the eval → dataset command tree", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const dataset = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "dataset");

    expect(dataset?.children().map((c) => c.name())).toEqual(["create"]);
  });

  test("prints help for bare `eval dataset` without calling the service", async () => {
    const { core, stdout, route } = testDatasetCommand();

    await route(["eval", "dataset"]);

    expect(stdout()).toContain("Usage: agentcore eval dataset");
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("dataset create", () => {
  test("builds inline examples from a file:// JSONL source", async () => {
    const path = writeTempJsonl(EXAMPLE_A, EXAMPLE_B);
    const { core, route } = testDatasetCommand();

    await route([
      "eval",
      "dataset",
      "create",
      "--name",
      "orders-regression",
      "--source",
      `file://${path}`,
      "--schema-type",
      "predefined",
    ]);

    expect(createDatasetInput(core)).toEqual({
      datasetName: "orders-regression",
      source: { inlineExamples: { examples: [EXAMPLE_A, EXAMPLE_B] } },
      schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
      description: undefined,
      kmsKeyArn: undefined,
      tags: undefined,
    });
  });

  test("reads examples from stdin", async () => {
    const { core, route } = testDatasetCommand(`${JSON.stringify(EXAMPLE_A)}\n`);

    await route([
      "eval",
      "dataset",
      "create",
      "--name",
      "orders-regression",
      "--source",
      "-",
      "--schema-type",
      "predefined",
    ]);

    expect(createDatasetInput(core).source).toEqual({
      inlineExamples: { examples: [EXAMPLE_A] },
    });
  });

  // An s3:// source is read by the service, so the CLI must pass the URI through
  // rather than trying to resolve it locally.
  test("passes an s3:// source through untouched", async () => {
    const { core, route } = testDatasetCommand();

    await route([
      "eval",
      "dataset",
      "create",
      "--name",
      "orders-regression",
      "--source",
      "s3://my-bucket/datasets/orders.jsonl",
      "--schema-type",
      "simulated",
    ]);

    const input = createDatasetInput(core);
    expect(input.source).toEqual({
      s3Source: { s3Uri: "s3://my-bucket/datasets/orders.jsonl" },
    });
    expect(input.schemaType).toBe("AGENTCORE_EVALUATION_SIMULATED_V1");
  });

  test("passes through description, KMS key, and tags", async () => {
    const path = writeTempJsonl(EXAMPLE_A);
    const { core, route } = testDatasetCommand();

    await route([
      "eval",
      "dataset",
      "create",
      "--name",
      "orders-regression",
      "--source",
      `file://${path}`,
      "--schema-type",
      "predefined",
      "--description",
      "Regression tests for the order-support agent",
      "--kms-key-arn",
      "arn:aws:kms:us-west-2:123456789012:key/abc",
      "--tags",
      "env=prod",
      "--tags",
      "team=agentcore",
    ]);

    expect(createDatasetInput(core)).toMatchObject({
      description: "Regression tests for the order-support agent",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/abc",
      tags: { env: "prod", team: "agentcore" },
    });
  });

  test("renders the service response as JSON", async () => {
    const path = writeTempJsonl(EXAMPLE_A);
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setCreateDatasetResponse({
      datasetId: "dataset-orders-abc123",
      datasetArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:dataset/dataset-orders-abc123",
      status: "CREATING",
      createdAt: new Date("2026-08-03T00:00:00Z"),
    });

    await route([
      "eval",
      "dataset",
      "create",
      "--name",
      "orders-regression",
      "--source",
      `file://${path}`,
      "--schema-type",
      "predefined",
    ]);

    expect(JSON.parse(stdout())).toMatchObject({
      datasetId: "dataset-orders-abc123",
      status: "CREATING",
    });
  });

  describe("input validation", () => {
    const path = () => writeTempJsonl(EXAMPLE_A);

    test("requires --name", async () => {
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--source",
        `file://${path()}`,
        "--schema-type",
        "predefined",
      ]);

      await expect(promise).rejects.toThrow(/--name/);
      expect(core.eval.calls).toHaveLength(0);
    });

    // The API has no way to create an empty dataset, so --source is required
    // even though the design doc lists it as optional.
    test("requires --source", async () => {
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--name",
        "orders-regression",
        "--schema-type",
        "predefined",
      ]);

      await expect(promise).rejects.toThrow(/--source/);
      expect(core.eval.calls).toHaveLength(0);
    });

    // schemaType is immutable after creation, so the customer chooses it rather
    // than inheriting a default that cannot later be corrected.
    test("requires --schema-type", async () => {
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--name",
        "orders-regression",
        "--source",
        `file://${path()}`,
      ]);

      await expect(promise).rejects.toThrow(/--schema-type/);
      expect(core.eval.calls).toHaveLength(0);
    });

    test("rejects an unknown --schema-type", async () => {
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--name",
        "orders-regression",
        "--source",
        `file://${path()}`,
        "--schema-type",
        "predefined-v1",
      ]);

      await expect(promise).rejects.toThrow();
      expect(core.eval.calls).toHaveLength(0);
    });

    // A bare path is the predictable first mistake: it parses as inline content
    // and dies on line 1, so the error names the documented spelling instead.
    test("suggests file:// when given a bare path", async () => {
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--name",
        "orders-regression",
        "--source",
        "./dataset/orders.jsonl",
        "--schema-type",
        "predefined",
      ]);

      await expect(promise).rejects.toThrow(/file:\/\/\.\/dataset\/orders\.jsonl/);
      expect(core.eval.calls).toHaveLength(0);
    });

    test("reports the offending line for malformed JSONL", async () => {
      const badPath = join(mkdtempSync(join(tmpdir(), "agentcore-dataset-")), "bad.jsonl");
      writeFileSync(badPath, `${JSON.stringify(EXAMPLE_A)}\n{"scenario_id": "broken"\n`);
      const { core, route } = testDatasetCommand();

      const promise = route([
        "eval",
        "dataset",
        "create",
        "--name",
        "orders-regression",
        "--source",
        `file://${badPath}`,
        "--schema-type",
        "predefined",
      ]);

      await expect(promise).rejects.toThrow(/line 2/);
      expect(core.eval.calls).toHaveLength(0);
    });
  });
});
