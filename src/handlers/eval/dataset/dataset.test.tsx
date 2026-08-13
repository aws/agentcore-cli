import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function writeTempJsonl(...examples: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-dataset-"));
  dirs.push(dir);
  const path = join(dir, "orders.jsonl");
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
    stderr: io.stderr,
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

    expect(dataset?.children().map((c) => c.name())).toEqual([
      "create",
      "get",
      "list",
      "delete",
      "update",
      "publish",
    ]);
  });

  test("prints help for bare `eval dataset --json` without calling the service", async () => {
    const { core, stdout, route } = testDatasetCommand();

    await route(["eval", "dataset", "--json"]);

    expect(stdout()).toContain("Usage: agentcore eval dataset");
    expect(core.eval.calls).toHaveLength(0);
  });

  test.each([["get"], ["list"]] as const)(
    "opens the TUI for a bare `eval dataset %s` leaf",
    async (command) => {
      const { route } = testDatasetCommand();

      await expect(route(["eval", "dataset", command])).rejects.toThrow(
        "interactive mode requires a TTY on stdin and stdout",
      );
    },
  );

  test("runs normal validation for a bare CLI-only dataset command", async () => {
    const { route } = testDatasetCommand();

    await expect(route(["eval", "dataset", "update"])).rejects.toThrow(
      "required option '--id <id>' not specified",
    );
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
      const badDir = mkdtempSync(join(tmpdir(), "agentcore-dataset-"));
      dirs.push(badDir);
      const badPath = join(badDir, "bad.jsonl");
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

describe("dataset get", () => {
  test("gets DRAFT metadata when no version is given", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setGetDatasetResponse({
      datasetId: "dataset-orders-abc123",
      datasetVersion: "DRAFT",
      datasetName: "orders-regression",
      status: "ACTIVE",
      draftStatus: "MODIFIED",
      schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
      exampleCount: 2,
    } as never);

    await route(["eval", "dataset", "get", "--id", "dataset-orders-abc123"]);

    const call = core.eval.calls.find((c) => c.method === "getDataset");
    expect(call?.args.slice(0, 2)).toEqual(["dataset-orders-abc123", undefined]);
    expect(JSON.parse(stdout())).toMatchObject({ datasetVersion: "DRAFT", exampleCount: 2 });
  });

  test("passes --version through to the service", async () => {
    const { core, route } = testDatasetCommand();

    await route(["eval", "dataset", "get", "--id", "dataset-orders-abc123", "--version", "1"]);

    const call = core.eval.calls.find((c) => c.method === "getDataset");
    expect(call?.args.slice(0, 2)).toEqual(["dataset-orders-abc123", "1"]);
  });

  // --file-path is what folds the previous CLI's `dataset download` into `get`:
  // metadata still goes to stdout, and the examples additionally land on disk.
  test("downloads examples when --file-path is given, still printing metadata", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setGetDatasetResponse({
      datasetId: "dataset-orders-abc123",
      datasetVersion: "DRAFT",
      exampleCount: 2,
    } as never);

    await route([
      "eval",
      "dataset",
      "get",
      "--id",
      "dataset-orders-abc123",
      "--file-path",
      "/tmp/out.jsonl",
    ]);

    // The download path replaces the plain get, rather than calling both.
    expect(core.eval.calls.map((c) => c.method)).toEqual(["downloadDataset"]);
    const call = core.eval.calls[0];
    expect(call?.args.slice(0, 3)).toEqual(["dataset-orders-abc123", undefined, "/tmp/out.jsonl"]);
    expect(JSON.parse(stdout())).toMatchObject({ exampleCount: 2, filePath: "/tmp/out.jsonl" });
  });

  test("downloads a specific version when --version and --file-path are combined", async () => {
    const { core, route } = testDatasetCommand();

    await route([
      "eval",
      "dataset",
      "get",
      "--id",
      "dataset-orders-abc123",
      "--version",
      "2",
      "--file-path",
      "/tmp/v2.jsonl",
    ]);

    const call = core.eval.calls.find((c) => c.method === "downloadDataset");
    expect(call?.args.slice(0, 3)).toEqual(["dataset-orders-abc123", "2", "/tmp/v2.jsonl"]);
  });

  test("requires --id", async () => {
    const { core, route } = testDatasetCommand();

    await expect(route(["eval", "dataset", "get", "--json"])).rejects.toThrow(/--id/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("dataset list", () => {
  test("lists datasets without pagination flags", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setListDatasetsResponse({
      datasets: [{ datasetId: "dataset-orders-abc123", datasetName: "orders-regression" }],
    } as never);

    await route(["eval", "dataset", "list", "--json"]);

    const call = core.eval.calls.find((c) => c.method === "listDatasets");
    expect(call?.args.slice(0, 2)).toEqual([undefined, undefined]);
    expect(JSON.parse(stdout()).datasets).toHaveLength(1);
  });

  test("paginates with --max-results and --next-token", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setListDatasetsResponse(
      { datasets: [{ datasetId: "second-page" }] } as never,
      "token-1",
    );

    await route(["eval", "dataset", "list", "--max-results", "1", "--next-token", "token-1"]);

    const call = core.eval.calls.find((c) => c.method === "listDatasets");
    expect(call?.args.slice(0, 2)).toEqual(["token-1", 1]);
    expect(JSON.parse(stdout()).datasets).toEqual([{ datasetId: "second-page" }]);
  });
});

describe("dataset delete", () => {
  test("deletes the whole dataset when no version is given", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setDeleteDatasetResponse({
      datasetId: "dataset-orders-abc123",
      status: "DELETING",
    } as never);

    await route(["eval", "dataset", "delete", "--id", "dataset-orders-abc123"]);

    const call = core.eval.calls.find((c) => c.method === "deleteDataset");
    expect(call?.args.slice(0, 2)).toEqual(["dataset-orders-abc123", undefined]);
    expect(JSON.parse(stdout())).toMatchObject({ status: "DELETING" });
  });

  // Passing a version narrows the delete to that published snapshot, leaving the
  // dataset and its other versions in place.
  test("deletes only the named version when --version is given", async () => {
    const { core, route } = testDatasetCommand();

    await route(["eval", "dataset", "delete", "--id", "dataset-orders-abc123", "--version", "1"]);

    const call = core.eval.calls.find((c) => c.method === "deleteDataset");
    expect(call?.args.slice(0, 2)).toEqual(["dataset-orders-abc123", "1"]);
  });

  // Deletion is destructive but takes no confirmation flag: headless commands
  // never prompt, and the CLI has no --yes convention.
  test("takes no confirmation flag", async () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const del = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "dataset")
      ?.children()
      .find((c) => c.name() === "delete");

    expect(del?.flags().map((f) => f.name)).toEqual(["id", "version"]);
  });

  test("requires --id", async () => {
    const { core, route } = testDatasetCommand();

    await expect(route(["eval", "dataset", "delete", "--json"])).rejects.toThrow(/--id/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("dataset publish", () => {
  test("publishes the DRAFT as a new version", async () => {
    const { core, stdout, route } = testDatasetCommand();
    core.eval.setPublishDatasetResponse({
      datasetId: "dataset-orders-abc123",
      datasetVersion: "1",
      status: "UPDATING",
    } as never);

    await route(["eval", "dataset", "publish", "--id", "dataset-orders-abc123"]);

    const call = core.eval.calls.find((c) => c.method === "publishDataset");
    expect(call?.args[0]).toBe("dataset-orders-abc123");
    expect(JSON.parse(stdout())).toMatchObject({ datasetVersion: "1", status: "UPDATING" });
  });

  test("takes only --id", async () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const publish = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "dataset")
      ?.children()
      .find((c) => c.name() === "publish");

    expect(publish?.flags().map((f) => f.name)).toEqual(["id"]);
  });

  test("publishes without inspecting draftStatus first", async () => {
    const { core, route } = testDatasetCommand();

    await route(["eval", "dataset", "publish", "--id", "dataset-orders-abc123"]);

    expect(core.eval.calls.map((c) => c.method)).toEqual(["publishDataset"]);
  });

  test("requires --id", async () => {
    const { core, route } = testDatasetCommand();

    await expect(route(["eval", "dataset", "publish", "--json"])).rejects.toThrow(/--id/);
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("dataset update", () => {
  test("updates the DRAFT from a local JSONL file", async () => {
    const path = writeTempJsonl(EXAMPLE_A);
    const { core, stdout, stderr, route } = testDatasetCommand();
    core.eval.setUpdateDatasetResult({
      datasetId: "dataset-orders-abc123",
      added: 1,
      updated: 2,
      deleted: 3,
      unchanged: 4,
    });

    await route([
      "eval",
      "dataset",
      "update",
      "--id",
      "dataset-orders-abc123",
      "--file-path",
      path,
    ]);

    const call = core.eval.calls.find((c) => c.method === "updateDatasetExamples");
    expect(call?.args.slice(0, 3)).toEqual([
      "dataset-orders-abc123",
      path,
      { region: REGION, endpointUrl: undefined },
    ]);
    const onProgress = call?.args[4] as ((event: { message: string }) => void) | undefined;
    onProgress?.({ message: "Applying update (batch 1 of 2)..." });
    expect(stderr()).toBe("Applying update (batch 1 of 2)...");
    expect(JSON.parse(stdout())).toEqual({
      datasetId: "dataset-orders-abc123",
      added: 1,
      updated: 2,
      deleted: 3,
      unchanged: 4,
    });
  });

  test("takes only --id and --file-path", async () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const update = root
      .children()
      .find((c) => c.name() === "eval")
      ?.children()
      .find((c) => c.name() === "dataset")
      ?.children()
      .find((c) => c.name() === "update");

    expect(update?.flags().map((f) => f.name)).toEqual(["id", "file-path"]);
  });

  test("requires --id", async () => {
    const path = writeTempJsonl(EXAMPLE_A);
    const { core, route } = testDatasetCommand();

    await expect(route(["eval", "dataset", "update", "--file-path", path])).rejects.toThrow(/--id/);
    expect(core.eval.calls).toHaveLength(0);
  });

  test("requires --file-path", async () => {
    const { core, route } = testDatasetCommand();

    await expect(
      route(["eval", "dataset", "update", "--id", "dataset-orders-abc123"]),
    ).rejects.toThrow(/--file-path/);
    expect(core.eval.calls).toHaveLength(0);
  });
});
