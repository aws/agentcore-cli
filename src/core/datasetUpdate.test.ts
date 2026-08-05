import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AddDatasetExamplesCommand,
  DeleteDatasetExamplesCommand,
  GetDatasetCommand,
  UpdateDatasetExamplesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { EvalClient } from "./eval";
import { NetworkingError } from "../errors";
import type { AwsClients, CoreFetch } from "./types";

const OPTIONS = { region: "us-west-2" };
const DOWNLOAD_URL = "https://example-bucket.s3.amazonaws.com/draft.jsonl";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-update-"));
  dirs.push(dir);
  const path = join(dir, "dataset.jsonl");
  writeFileSync(path, contents);
  return path;
}

function jsonl(...rows: Record<string, unknown>[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function stubClients(options: {
  commands: unknown[];
  dataset?: Record<string, unknown>;
  addIds?: string[];
}): AwsClients {
  let addOffset = 0;
  const dataset = options.dataset ?? {
    datasetId: "d-1",
    datasetVersion: "DRAFT",
    status: "ACTIVE",
    exampleCount: 3,
    downloadUrl: DOWNLOAD_URL,
  };
  const send = async (command: unknown) => {
    options.commands.push(command);
    if (command instanceof GetDatasetCommand) return dataset;
    if (command instanceof DeleteDatasetExamplesCommand) return { status: "UPDATING" };
    if (command instanceof UpdateDatasetExamplesCommand) return { status: "UPDATING" };
    if (command instanceof AddDatasetExamplesCommand) {
      const batchSize = command.input.source?.inlineExamples?.examples?.length ?? 0;
      const exampleIds = (options.addIds ?? ["fresh-id"]).slice(addOffset, addOffset + batchSize);
      addOffset += batchSize;
      return { status: "UPDATING", exampleIds };
    }
    throw new Error(`unexpected command: ${(command as object).constructor.name}`);
  };
  const client = { send } as never;
  return { control: () => client, data: () => client, iam: () => client };
}

describe("EvalClient.updateDatasetExamples", () => {
  test("reconciles local JSONL into remote DRAFT and writes assigned ids back", async () => {
    const localPath = tempFile(
      jsonl(
        { exampleId: "keep", scenario_id: "same" },
        { exampleId: "change", scenario_id: "edited" },
        { scenario_id: "new" },
      ),
    );
    const remote = jsonl(
      { exampleId: "keep", scenario_id: "same" },
      { exampleId: "change", scenario_id: "old" },
      { exampleId: "gone", scenario_id: "delete-me" },
    );
    const commands: unknown[] = [];
    const fetch = (async () => new Response(remote, { status: 200 })) as CoreFetch;
    const client = new EvalClient(stubClients({ commands }), fetch);

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);

    expect(result).toEqual({
      datasetId: "d-1",
      added: 1,
      updated: 1,
      deleted: 1,
      unchanged: 1,
    });
    expect(commands.map((c) => (c as object).constructor.name)).toEqual([
      "GetDatasetCommand",
      "DeleteDatasetExamplesCommand",
      "GetDatasetCommand",
      "UpdateDatasetExamplesCommand",
      "GetDatasetCommand",
      "AddDatasetExamplesCommand",
      "GetDatasetCommand",
    ]);

    const deleteInput = (commands[1] as DeleteDatasetExamplesCommand).input;
    expect(deleteInput).toMatchObject({ datasetId: "d-1", exampleIds: ["gone"] });
    expect(typeof deleteInput.clientToken).toBe("string");

    const updateInput = (commands[3] as UpdateDatasetExamplesCommand).input;
    expect(updateInput).toMatchObject({
      datasetId: "d-1",
      examples: [{ exampleId: "change", scenario_id: "edited" }],
    });
    expect(typeof updateInput.clientToken).toBe("string");

    const addInput = (commands[5] as AddDatasetExamplesCommand).input;
    expect(addInput).toMatchObject({
      datasetId: "d-1",
      source: { inlineExamples: { examples: [{ scenario_id: "new" }] } },
    });
    expect(typeof addInput.clientToken).toBe("string");

    const written = readFileSync(localPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(written).toEqual([
      { exampleId: "keep", scenario_id: "same" },
      { exampleId: "change", scenario_id: "edited" },
      { exampleId: "fresh-id", scenario_id: "new" },
    ]);
  });

  test("treats an ACTIVE empty remote DRAFT without a download URL as empty", async () => {
    const localPath = tempFile(jsonl({ scenario_id: "new" }));
    const commands: unknown[] = [];
    const fetch = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as CoreFetch;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
      }),
      fetch,
    );

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);

    expect(result).toMatchObject({ added: 1, updated: 0, deleted: 0, unchanged: 0 });
    expect(commands.some((c) => c instanceof AddDatasetExamplesCommand)).toBe(true);
  });

  test("batches additions to the service limit", async () => {
    const localRows = Array.from({ length: 1001 }, (_, i) => ({ scenario_id: `new-${i}` }));
    const localPath = tempFile(jsonl(...localRows));
    const commands: unknown[] = [];
    const fetch = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as CoreFetch;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        addIds: Array.from({ length: 1001 }, (_, i) => `fresh-${i}`),
      }),
      fetch,
    );

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);
    const addCommands = commands.filter(
      (command): command is AddDatasetExamplesCommand =>
        command instanceof AddDatasetExamplesCommand,
    );

    expect(result.added).toBe(1001);
    expect(addCommands).toHaveLength(2);
    expect(addCommands[0]?.input.source?.inlineExamples?.examples).toHaveLength(1000);
    expect(addCommands[1]?.input.source?.inlineExamples?.examples).toHaveLength(1);
  });

  test("does not mutate while the dataset is not ACTIVE", async () => {
    const localPath = tempFile(jsonl({ scenario_id: "new" }));
    const commands: unknown[] = [];
    const fetch = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as CoreFetch;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: {
          datasetId: "d-1",
          datasetVersion: "DRAFT",
          status: "UPDATING",
          exampleCount: 0,
        },
      }),
      fetch,
    );

    await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
      NetworkingError,
    );
    expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
  });

  test("leaves the local file untouched when there are no additions", async () => {
    const contents = jsonl({ exampleId: "keep", scenario_id: "same" });
    const localPath = tempFile(contents);
    const commands: unknown[] = [];
    const fetch = (async () => new Response(contents, { status: 200 })) as CoreFetch;
    const client = new EvalClient(stubClients({ commands }), fetch);

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);

    expect(result).toMatchObject({ added: 0, updated: 0, deleted: 0, unchanged: 1 });
    expect(readFileSync(localPath, "utf8")).toBe(contents);
    expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
  });
});
