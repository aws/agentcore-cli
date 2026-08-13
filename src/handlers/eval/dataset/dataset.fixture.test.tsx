import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteDatasetCommand, GetDatasetCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { createControlClient } from "../../../core/factories";
import {
  createSilentLogger,
  fixtureFactories,
  fixtureFetch,
  isRecording,
  matchGolden,
  settle,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";
const FIXTURES = join(import.meta.dir, "__fixtures__");
const UPDATE_FIXTURES = join(FIXTURES, "update");

// Record with RECORD=1 bun test src/handlers/eval/dataset/dataset.fixture.test.tsx
// The RECORD run walks one dataset through its whole life against the live API —
// create, get, list, publish, get the published version, delete that version,
// delete the dataset
const DATASET_NAME = "agentcore_cli_dataset_fixture";
// Second dataset so list pagination has a page boundary.
const SECOND_DATASET_NAME = "agentcore_cli_dataset_fixture_second";

const EXAMPLES = [
  {
    scenario_id: "shipped-order",
    turns: [
      {
        input: "Where is order 12345?",
        expectedResponse: "Order 12345 has shipped with UPS and arrives on July 23, 2026.",
      },
    ],
    assertions: ["The response includes the shipping status."],
    expected_trajectory: ["lookup_order"],
  },
  {
    scenario_id: "unknown-order",
    turns: [
      {
        input: "Where is order 99999?",
        expectedResponse: "I could not find order 99999. Please verify the order number.",
      },
    ],
    assertions: ["The response states that the order was not found."],
    expected_trajectory: ["lookup_order"],
  },
];

const MISSING_DATASET_ID = "missing_dataset-0000000000";

const dirs: string[] = [];

function writeExamples(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-dataset-fixture-"));
  dirs.push(dir);
  const path = join(dir, "orders.jsonl");
  writeFileSync(path, `${EXAMPLES.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

async function writeUpdateExamples(): Promise<{
  path: string;
  keptExampleId: string;
  deletedExampleId: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-dataset-update-fixture-"));
  dirs.push(dir);
  const path = join(dir, "orders-update.jsonl");

  // Use the IDs assigned by the live service or returned by the download
  // fixture. This keeps record and replay on the same code path.
  await run(["eval", "dataset", "get", "--id", datasetId, "--file-path", path], UPDATE_FIXTURES);
  const current = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const kept = current.find((example) => example.scenario_id === "shipped-order");
  const deleted = current.find((example) => example.scenario_id === "unknown-order");

  expect(current).toHaveLength(EXAMPLES.length);
  expect(kept?.exampleId).toBeString();
  expect(deleted?.exampleId).toBeString();

  const keptExampleId = kept!.exampleId as string;
  const deletedExampleId = deleted!.exampleId as string;
  const updated = {
    ...kept,
    turns: [
      {
        input: "Where is order 12345?",
        expectedResponse: "Order 12345 shipped with UPS and now arrives on July 24, 2026.",
      },
    ],
  };
  const added = {
    scenario_id: "address-change",
    turns: [
      {
        input: "Can I change the shipping address for order 24680?",
        expectedResponse: "I can help change the shipping address if the order has not shipped.",
      },
    ],
    assertions: ["The response explains when the shipping address can be changed."],
    expected_trajectory: ["lookup_order", "update_shipping_address"],
  };
  writeFileSync(path, `${[updated, added].map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { path, keptExampleId, deletedExampleId };
}

function createFixtureCore(fixtures: string): CoreClient {
  const { createControlClient, createDataClient, createIamClient, createLogsClient } =
    fixtureFactories(fixtures);
  return new CoreClient({
    createControlClient,
    createDataClient,
    createIamClient,
    createLogsClient,
    logger: createSilentLogger(),
    fetch: fixtureFetch(fixtures),
  });
}

async function run(args: string[], fixtures = FIXTURES): Promise<string> {
  const io = testIO();
  const root = createRootHandler(createFixtureCore(fixtures), {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return io.stdout();
}

let datasetId: string;
let secondDatasetId: string;
let publishedVersion: string;

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  if (!isRecording()) return;

  const control = createControlClient({ region: REGION });
  for (const id of [datasetId, secondDatasetId].filter(Boolean)) {
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const dataset = await control.send(new GetDatasetCommand({ datasetId: id }));
        if (dataset.status === "ACTIVE" || dataset.status?.endsWith("_FAILED")) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await control.send(new DeleteDatasetCommand({ datasetId: id }));
    } catch (error) {
      // ResourceNotFoundException is the expected outcome
      // Indicates that tests deleted the dataset successfully
      if ((error as Error)?.name === "ResourceNotFoundException") continue;
      console.error(`could not delete fixture dataset ${id}:`, error);
    }
  }
});

describe("eval dataset against recorded responses", () => {
  test("creates a dataset from a JSONL file", async () => {
    const stdout = await run([
      "eval",
      "dataset",
      "create",
      "--name",
      DATASET_NAME,
      "--source",
      `file://${writeExamples()}`,
      "--schema-type",
      "predefined",
      "--description",
      "Recorded fixture for the dataset commands",
    ]);

    const response = JSON.parse(stdout);
    datasetId = response.datasetId;

    matchGolden(FIXTURES, "create.golden.json", stdout);
    expect(datasetId).toBeString();
    // Ingestion is asynchronous and the CLI does not poll, so the initial status
    // is always CREATING.
    expect(response.status).toBe("CREATING");
  });

  // exampleCount is proof that the local JSONL was translated into inlineExamples
  test("gets the DRAFT's metadata", async () => {
    await settle();

    const stdout = await run(["eval", "dataset", "get", "--id", datasetId]);

    matchGolden(FIXTURES, "get-draft.golden.json", stdout);
    const response = JSON.parse(stdout);
    expect(response.datasetVersion).toBe("DRAFT");
    expect(response.exampleCount).toBe(EXAMPLES.length);
    expect(response.schemaType).toBe("AGENTCORE_EVALUATION_PREDEFINED_V1");
    expect(response.draftStatus).toBe("MODIFIED");
  }, 60_000);

  test("updates the DRAFT from a local JSONL file", async () => {
    await settle();
    const { path, keptExampleId, deletedExampleId } = await writeUpdateExamples();

    const stdout = await run(
      ["eval", "dataset", "update", "--id", datasetId, "--file-path", path],
      UPDATE_FIXTURES,
    );

    matchGolden(FIXTURES, "update.golden.json", stdout);
    expect(JSON.parse(stdout)).toEqual({
      datasetId,
      added: 1,
      updated: 1,
      deleted: 1,
      unchanged: 0,
    });

    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.scenario_id)).toEqual(["shipped-order", "address-change"]);
    expect(rows[0].exampleId).toBe(keptExampleId);
    expect(rows[1].exampleId).toBeString();
    expect(rows[1].exampleId).not.toBe(keptExampleId);
    expect(rows[1].exampleId).not.toBe(deletedExampleId);
  }, 60_000);

  test("lists datasets", async () => {
    const stdout = await run(["eval", "dataset", "list", "--json"]);

    matchGolden(FIXTURES, "list.golden.json", stdout);
    expect(JSON.parse(stdout).datasets).toBeArray();
  });

  // Pagination needs at least two datasets to produce a token, so the second one
  // is created here rather than assumed to exist in the recording account.
  test("paginates the list with --max-results and --next-token", async () => {
    const secondStdout = await run([
      "eval",
      "dataset",
      "create",
      "--name",
      SECOND_DATASET_NAME,
      "--source",
      `file://${writeExamples()}`,
      "--schema-type",
      "predefined",
    ]);
    secondDatasetId = JSON.parse(secondStdout).datasetId;
    await settle();

    const firstPage = await run(["eval", "dataset", "list", "--max-results", "1"]);
    matchGolden(FIXTURES, "list-page-1.golden.json", firstPage);

    const first = JSON.parse(firstPage);
    expect(first.datasets).toHaveLength(1);
    expect(first.nextToken).toBeString();

    const secondPage = await run([
      "eval",
      "dataset",
      "list",
      "--max-results",
      "1",
      "--next-token",
      first.nextToken,
    ]);
    matchGolden(FIXTURES, "list-page-2.golden.json", secondPage);
    expect(JSON.parse(secondPage).datasets).toHaveLength(1);
  }, 60_000);

  test("publishes the DRAFT as a numbered version", async () => {
    await settle();

    const stdout = await run(["eval", "dataset", "publish", "--id", datasetId]);

    const response = JSON.parse(stdout);
    publishedVersion = response.datasetVersion;

    matchGolden(FIXTURES, "publish.golden.json", stdout);
    // Version number is assigned by service
    expect(publishedVersion).toBe("1");
    expect(response.status).toBe("UPDATING");
  }, 60_000);

  // A published version is an immutable snapshot of the DRAFT at publish time, so
  // it reports the same example count under its own version number.
  test("gets the published version's metadata", async () => {
    await settle();
    expect(publishedVersion).toBeString();

    const stdout = await run([
      "eval",
      "dataset",
      "get",
      "--id",
      datasetId,
      "--version",
      publishedVersion,
    ]);

    matchGolden(FIXTURES, "get-version.golden.json", stdout);
    const response = JSON.parse(stdout);
    expect(response.datasetVersion).toBe(publishedVersion);
    expect(response.exampleCount).toBe(EXAMPLES.length);
  }, 60_000);

  test("deletes a single published version", async () => {
    expect(publishedVersion).toBeString();

    const stdout = await run([
      "eval",
      "dataset",
      "delete",
      "--id",
      datasetId,
      "--version",
      publishedVersion,
    ]);

    matchGolden(FIXTURES, "delete-version.golden.json", stdout);
    expect(JSON.parse(stdout).datasetVersion).toBe(publishedVersion);
  });

  test("deletes the dataset and all of its versions", async () => {
    await settle();

    const stdout = await run(["eval", "dataset", "delete", "--id", datasetId]);

    matchGolden(FIXTURES, "delete.golden.json", stdout);
    expect(JSON.parse(stdout).status).toBe("DELETING");
  }, 60_000);

  test("reports a dataset that does not exist", async () => {
    const promise = run(["eval", "dataset", "get", "--id", MISSING_DATASET_ID]);

    await expect(promise).rejects.toThrow(/does not exist/i);
  });
});
