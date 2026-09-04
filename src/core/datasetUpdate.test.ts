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
import { InputValidationError } from "../errors";
import type { AwsClients, CoreFetch } from "./types";

const OPTIONS = { region: "us-west-2" };
const DOWNLOAD_URL = "https://example-bucket.s3.amazonaws.com/draft.jsonl";
const PAYLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

type RequestOptions = { abortSignal?: AbortSignal };

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
  datasetAfterMutation?: Record<string, unknown>;
  addIds?: string[];
  requestOptions?: (RequestOptions | undefined)[];
  beforeSend?: (
    command: unknown,
    requestOptions: RequestOptions | undefined,
  ) => void | Promise<void>;
}): AwsClients {
  let addOffset = 0;
  let mutationStarted = false;
  const dataset = options.dataset ?? {
    datasetId: "d-1",
    datasetVersion: "DRAFT",
    status: "ACTIVE",
    exampleCount: 3,
    downloadUrl: DOWNLOAD_URL,
  };
  const send = async (command: unknown, requestOptions?: RequestOptions) => {
    options.commands.push(command);
    options.requestOptions?.push(requestOptions);
    await options.beforeSend?.(command, requestOptions);
    if (command instanceof GetDatasetCommand) {
      return mutationStarted ? (options.datasetAfterMutation ?? dataset) : dataset;
    }
    if (command instanceof DeleteDatasetExamplesCommand) {
      mutationStarted = true;
      return { status: "UPDATING" };
    }
    if (command instanceof UpdateDatasetExamplesCommand) {
      mutationStarted = true;
      return { status: "UPDATING" };
    }
    if (command instanceof AddDatasetExamplesCommand) {
      mutationStarted = true;
      const batchSize = command.input.source?.inlineExamples?.examples?.length ?? 0;
      const exampleIds = (options.addIds ?? ["fresh-id"]).slice(addOffset, addOffset + batchSize);
      addOffset += batchSize;
      return { status: "UPDATING", exampleIds };
    }
    throw new Error(`unexpected command: ${(command as object).constructor.name}`);
  };
  const client = { send } as never;
  return {
    control: () => client,
    data: () => client,
    iam: () => client,
    logs: () => client,
    s3: () => client,
  };
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
    const requestOptions: (RequestOptions | undefined)[] = [];
    const fetch = (async () => new Response(remote, { status: 200 })) as CoreFetch;
    const client = new EvalClient(stubClients({ commands, requestOptions }), fetch);
    const controller = new AbortController();
    const progress: string[] = [];

    const result = await client.updateDatasetExamples(
      "d-1",
      localPath,
      OPTIONS,
      controller.signal,
      (event) => progress.push(event.message),
    );

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
    expect(requestOptions).toHaveLength(commands.length);
    expect(requestOptions.every((options) => options?.abortSignal === controller.signal)).toBe(
      true,
    );
    expect(progress).toEqual([
      "Applying update (batch 1 of 3)...",
      "Applying update (batch 2 of 3)...",
      "Applying update (batch 3 of 3)...",
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

    const progress: string[] = [];
    const result = await client.updateDatasetExamples(
      "d-1",
      localPath,
      OPTIONS,
      undefined,
      (event) => progress.push(event.message),
    );
    const addCommands = commands.filter(
      (command): command is AddDatasetExamplesCommand =>
        command instanceof AddDatasetExamplesCommand,
    );

    expect(result.added).toBe(1001);
    expect(addCommands).toHaveLength(2);
    expect(addCommands[0]?.input.source?.inlineExamples?.examples).toHaveLength(1000);
    expect(addCommands[1]?.input.source?.inlineExamples?.examples).toHaveLength(1);
    expect(progress).toEqual([
      "Applying update (batch 1 of 2)...",
      "Applying update (batch 2 of 2)...",
    ]);
  });

  test("batches additions by UTF-8 encoded request size", async () => {
    const largeValue = "\u{1f600}".repeat(700_000);
    const localPath = tempFile(
      jsonl(
        { scenario_id: "large-1", value: largeValue },
        { scenario_id: "large-2", value: largeValue },
      ),
    );
    const commands: unknown[] = [];
    const fetch = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as CoreFetch;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        addIds: ["fresh-1", "fresh-2"],
      }),
      fetch,
    );

    await client.updateDatasetExamples("d-1", localPath, OPTIONS);
    const addCommands = commands.filter(
      (command): command is AddDatasetExamplesCommand =>
        command instanceof AddDatasetExamplesCommand,
    );

    expect(addCommands).toHaveLength(2);
    for (const command of addCommands) {
      expect(Buffer.byteLength(JSON.stringify(command.input), "utf8")).toBeLessThanOrEqual(
        PAYLOAD_LIMIT_BYTES,
      );
    }
  });

  test("batches updates by encoded request size", async () => {
    const largeValue = "x".repeat(3 * 1024 * 1024);
    const localPath = tempFile(
      jsonl(
        { exampleId: "large-1", scenario_id: "large-1", value: largeValue },
        { exampleId: "large-2", scenario_id: "large-2", value: largeValue },
      ),
    );
    const remote = jsonl(
      { exampleId: "large-1", scenario_id: "large-1", value: "old" },
      { exampleId: "large-2", scenario_id: "large-2", value: "old" },
    );
    const commands: unknown[] = [];
    const client = new EvalClient(
      stubClients({ commands }),
      (async () => new Response(remote, { status: 200 })) as CoreFetch,
    );

    await client.updateDatasetExamples("d-1", localPath, OPTIONS);
    const updateCommands = commands.filter(
      (command): command is UpdateDatasetExamplesCommand =>
        command instanceof UpdateDatasetExamplesCommand,
    );

    expect(updateCommands).toHaveLength(2);
    expect(updateCommands.every((command) => command.input.examples?.length === 1)).toBe(true);
    expect(
      updateCommands.every(
        (command) =>
          Buffer.byteLength(JSON.stringify(command.input), "utf8") <= PAYLOAD_LIMIT_BYTES,
      ),
    ).toBe(true);
  });

  test("includes datasetId when rejecting an oversized mutation before changing the dataset", async () => {
    const clientToken = "0".repeat(36);
    const example = { scenario_id: "too-large", value: "" };
    const bodyWithoutDatasetId = {
      source: { inlineExamples: { examples: [example] } },
      clientToken,
    };
    const valueBytes =
      PAYLOAD_LIMIT_BYTES - Buffer.byteLength(JSON.stringify(bodyWithoutDatasetId));
    example.value = "x".repeat(valueBytes);
    expect(Buffer.byteLength(JSON.stringify(bodyWithoutDatasetId))).toBe(PAYLOAD_LIMIT_BYTES);

    const localPath = tempFile(jsonl(example));
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

    await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
      InputValidationError,
    );
    expect(commands.map((command) => (command as object).constructor.name)).toEqual([
      "GetDatasetCommand",
    ]);
  });

  test("recovers a CREATE_FAILED dataset from an empty draft", async () => {
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
          status: "CREATE_FAILED",
          exampleCount: 0,
        },
        datasetAfterMutation: {
          datasetId: "d-1",
          datasetVersion: "DRAFT",
          status: "ACTIVE",
          exampleCount: 1,
        },
      }),
      fetch,
    );

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);

    expect(result.added).toBe(1);
    expect(commands.some((command) => command instanceof AddDatasetExamplesCommand)).toBe(true);
  });

  test("recovers an UPDATE_FAILED dataset from its partial draft", async () => {
    const localPath = tempFile(jsonl({ exampleId: "existing", scenario_id: "edited" }));
    const remote = jsonl({ exampleId: "existing", scenario_id: "old" });
    const commands: unknown[] = [];
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: {
          datasetId: "d-1",
          datasetVersion: "DRAFT",
          status: "UPDATE_FAILED",
          exampleCount: 1,
          downloadUrl: DOWNLOAD_URL,
        },
        datasetAfterMutation: {
          datasetId: "d-1",
          datasetVersion: "DRAFT",
          status: "ACTIVE",
          exampleCount: 1,
        },
      }),
      (async () => new Response(remote, { status: 200 })) as CoreFetch,
    );

    const result = await client.updateDatasetExamples("d-1", localPath, OPTIONS);

    expect(result.updated).toBe(1);
    expect(commands.some((command) => command instanceof UpdateDatasetExamplesCommand)).toBe(true);
  });

  test.each(["CREATING", "UPDATING"])(
    "tells the user when to retry while the dataset is %s",
    async (status) => {
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
            status,
            exampleCount: 0,
          },
        }),
        fetch,
      );

      await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
        `Dataset "d-1" cannot be updated with status ${status}. ` +
          `Retry once its status is ACTIVE.`,
      );
      expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
    },
  );

  test("omits retry guidance for a non-retryable status", async () => {
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
          status: "DELETE_FAILED",
          exampleCount: 0,
        },
      }),
      fetch,
    );

    await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
      'Dataset "d-1" cannot be updated with status DELETE_FAILED.',
    );
    expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
  });

  test("explains how to retry when the service omits non-empty DRAFT contents", async () => {
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
          status: "UPDATE_FAILED",
          failureReason: "The previous update timed out.",
          exampleCount: 1,
        },
      }),
      fetch,
    );

    await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
      'Dataset "d-1" has no downloadable DRAFT content yet (status UPDATE_FAILED); ' +
        "retry once DRAFT content is available",
    );
    expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
  });

  test("persists IDs from each successful add batch before starting the next", async () => {
    const localRows = Array.from({ length: 1001 }, (_, i) => ({ scenario_id: `new-${i}` }));
    const localPath = tempFile(jsonl(...localRows));
    const commands: unknown[] = [];
    let addCalls = 0;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        addIds: Array.from({ length: 1000 }, (_, i) => `fresh-${i}`),
        beforeSend: (command) => {
          if (!(command instanceof AddDatasetExamplesCommand) || ++addCalls !== 2) return;
          const checkpoint = readFileSync(localPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(checkpoint[0]?.exampleId).toBe("fresh-0");
          expect(checkpoint[999]?.exampleId).toBe("fresh-999");
          expect(checkpoint[1000]).not.toHaveProperty("exampleId");
          throw new Error("second add batch failed");
        },
      }),
      (() => {
        throw new Error("fetch should not be called");
      }) as unknown as CoreFetch,
    );

    await expect(client.updateDatasetExamples("d-1", localPath, OPTIONS)).rejects.toThrow(
      "second add batch failed",
    );
    const checkpoint = readFileSync(localPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(checkpoint.filter((row) => row.exampleId !== undefined)).toHaveLength(1000);
  });

  test("preserves concurrent edits and stops after writing assigned IDs to a recovery file", async () => {
    const localRows = Array.from({ length: 1001 }, (_, i) => ({ scenario_id: `new-${i}` }));
    const localPath = tempFile(jsonl(...localRows));
    const editedContents = jsonl({ scenario_id: "edited-while-request-was-running" });
    const commands: unknown[] = [];
    let addCalls = 0;
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        addIds: Array.from({ length: 1000 }, (_, i) => `fresh-${i}`),
        beforeSend: (command) => {
          if (!(command instanceof AddDatasetExamplesCommand) || ++addCalls !== 1) return;
          writeFileSync(localPath, editedContents);
        },
      }),
      (() => {
        throw new Error("fetch should not be called");
      }) as unknown as CoreFetch,
    );

    let conflict: unknown;
    try {
      await client.updateDatasetExamples("d-1", localPath, OPTIONS);
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(InputValidationError);
    const recoveryFilePath = (conflict as InputValidationError).meta.recoveryFilePath;
    expect(recoveryFilePath).toBeString();
    expect(readFileSync(localPath, "utf8")).toBe(editedContents);

    const recovered = readFileSync(recoveryFilePath as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(recovered[0]?.exampleId).toBe("fresh-0");
    expect(recovered[999]?.exampleId).toBe("fresh-999");
    expect(recovered[1000]).not.toHaveProperty("exampleId");
    expect(commands.filter((command) => command instanceof AddDatasetExamplesCommand)).toHaveLength(
      1,
    );
    expect(commands.at(-1)).toBeInstanceOf(GetDatasetCommand);
  });

  test("aborts a pending mutation through the SDK request options", async () => {
    const localPath = tempFile(jsonl({ scenario_id: "new" }));
    const commands: unknown[] = [];
    const controller = new AbortController();
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        beforeSend: async (command, requestOptions) => {
          if (!(command instanceof AddDatasetExamplesCommand)) return;
          mutationStarted();
          const signal = requestOptions?.abortSignal;
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
      (() => {
        throw new Error("fetch should not be called");
      }) as unknown as CoreFetch,
    );

    const update = client.updateDatasetExamples("d-1", localPath, OPTIONS, controller.signal);
    await started;
    controller.abort();

    await expect(update).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborts promptly while waiting between dataset status polls", async () => {
    const localPath = tempFile(jsonl({ scenario_id: "new" }));
    const commands: unknown[] = [];
    const controller = new AbortController();
    let getCalls = 0;
    let pollCompleted!: () => void;
    const polled = new Promise<void>((resolve) => {
      pollCompleted = resolve;
    });
    const client = new EvalClient(
      stubClients({
        commands,
        dataset: { datasetId: "d-1", datasetVersion: "DRAFT", status: "ACTIVE", exampleCount: 0 },
        datasetAfterMutation: {
          datasetId: "d-1",
          datasetVersion: "DRAFT",
          status: "UPDATING",
          exampleCount: 1,
        },
        beforeSend: (command) => {
          if (command instanceof GetDatasetCommand && ++getCalls === 2) pollCompleted();
        },
      }),
      (() => {
        throw new Error("fetch should not be called");
      }) as unknown as CoreFetch,
    );

    const update = client.updateDatasetExamples("d-1", localPath, OPTIONS, controller.signal);
    await polled;
    await Bun.sleep(0);
    controller.abort();
    const outcome = await Promise.race([
      update.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      Bun.sleep(100).then(() => "timeout"),
    ]);

    expect(outcome).not.toBe("timeout");
    expect(outcome).toMatchObject({ name: "AbortError" });
  });

  test("leaves the local file untouched when there are no additions", async () => {
    const contents = jsonl({ exampleId: "keep", scenario_id: "same" });
    const localPath = tempFile(contents);
    const commands: unknown[] = [];
    const fetch = (async () => new Response(contents, { status: 200 })) as CoreFetch;
    const client = new EvalClient(stubClients({ commands }), fetch);

    const progress: string[] = [];
    const result = await client.updateDatasetExamples(
      "d-1",
      localPath,
      OPTIONS,
      undefined,
      (event) => progress.push(event.message),
    );

    expect(result).toMatchObject({ added: 0, updated: 0, deleted: 0, unchanged: 1 });
    expect(progress).toEqual([]);
    expect(readFileSync(localPath, "utf8")).toBe(contents);
    expect(commands.map((c) => (c as object).constructor.name)).toEqual(["GetDatasetCommand"]);
  });
});
