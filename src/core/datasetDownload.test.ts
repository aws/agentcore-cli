import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { GetDatasetCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { EvalClient } from "./eval";
import { ERROR_SOURCE, FileWriteError, NetworkingError } from "../errors";
import type { AwsClients, CoreFetch } from "./types";

const OPTIONS = { region: "us-west-2" };
const DOWNLOAD_URL = "https://example-bucket.s3.amazonaws.com/orders.jsonl?X-Amz-Signature=abc";
const JSONL = '{"scenario_id":"shipped-order"}\n{"scenario_id":"unknown-order"}\n';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-download-"));
  dirs.push(dir);
  return join(dir, "out.jsonl");
}

// stubClients answers GetDatasetCommand with `dataset` and rejects anything else,
// so a test that reaches an unexpected operation fails loudly.
function stubClients(dataset: Record<string, unknown>): AwsClients {
  const send = async (command: unknown) => {
    if (command instanceof GetDatasetCommand) return dataset;
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

describe("EvalClient.downloadDataset", () => {
  test("writes the fetched JSONL to the requested path and returns the metadata", async () => {
    const path = tempPath();
    const requested: string[] = [];
    const fetch = (async (url: unknown) => {
      requested.push(String(url));
      return new Response(JSONL, { status: 200 });
    }) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", datasetVersion: "DRAFT", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const metadata = await client.downloadDataset("d-1", undefined, path, OPTIONS);

    expect(readFileSync(path, "utf8")).toBe(JSONL);
    expect(requested).toEqual([DOWNLOAD_URL]);
    expect(metadata.datasetVersion).toBe("DRAFT");
  });

  // The consolidated file is written asynchronously, so a dataset that is still
  // ingesting has no URL yet. The status is the actionable part of the message.
  test("reports the dataset status when no download URL is available", async () => {
    const fetch = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as CoreFetch;
    const client = new EvalClient(stubClients({ datasetId: "d-1", status: "CREATING" }), fetch);

    const promise = client.downloadDataset("d-1", undefined, tempPath(), OPTIONS);

    await expect(promise).rejects.toThrow(NetworkingError);
    await expect(promise).rejects.toThrow(/CREATING/);
  });

  // A presigned URL expires minutes after it is issued, so a 403 here is an
  // ordinary outcome rather than a bug; it must not surface as a stack trace.
  test("surfaces a non-OK HTTP response as a networking error", async () => {
    const fetch = (async () => new Response("expired", { status: 403 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const promise = client.downloadDataset("d-1", undefined, tempPath(), OPTIONS);

    await expect(promise).rejects.toThrow(NetworkingError);
    await expect(promise).rejects.toThrow(/HTTP 403/);
  });

  test("lets unknown transport failures bubble up for root classification", async () => {
    const fetch = (async () => {
      throw new Error("socket hang up");
    }) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const promise = client.downloadDataset("d-1", undefined, tempPath(), OPTIONS);

    await expect(promise).rejects.toThrow("socket hang up");
    await expect(promise).rejects.not.toBeInstanceOf(NetworkingError);
  });

  test("requests the named version's content", async () => {
    const fetch = (async () => new Response(JSONL, { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", datasetVersion: "2", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const metadata = await client.downloadDataset("d-1", "2", tempPath(), OPTIONS);

    expect(metadata.datasetVersion).toBe("2");
  });

  // A failed download must not clobber a complete file: the example diff in
  // `update` reads this file to match exampleIds, so truncation there would read
  // as deleted examples. The write goes to a temp file and is renamed only once
  // the transfer finishes, so a failure leaves the destination untouched.
  test("leaves an existing file intact when the download fails", async () => {
    const path = tempPath();
    writeFileSync(path, "PREVIOUS CONTENT\n");
    const fetch = (async () => new Response("expired", { status: 403 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await expect(client.downloadDataset("d-1", undefined, path, OPTIONS)).rejects.toThrow(
      NetworkingError,
    );

    expect(readFileSync(path, "utf8")).toBe("PREVIOUS CONTENT\n");
    // No temp file is left beside the destination.
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // A local write failure is the caller's to fix, not the service's, so it is
  // reported separately from a fetch failure and telemetry attributes it correctly.
  test("reports an unwritable destination as a user error, not a service one", async () => {
    const fetch = (async () => new Response(JSONL, { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    // A path whose parent directory does not exist.
    const promise = client.downloadDataset(
      "d-1",
      undefined,
      join(tempPath(), "missing-dir", "out.jsonl"),
      OPTIONS,
    );

    await expect(promise).rejects.toThrow(FileWriteError);
    await expect(promise).rejects.toMatchObject({ source: ERROR_SOURCE.USER });
  });

  // The service's consolidated file ends without a trailing newline, which makes
  // it unsafe to append to: a scenario added to the end would concatenate onto the
  // last object and produce malformed JSONL. Verified against the live API.
  test("appends a trailing newline when the body lacks one", async () => {
    const path = tempPath();
    const fetch = (async () => new Response('{"a":1}\n{"b":2}', { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await client.downloadDataset("d-1", undefined, path, OPTIONS);

    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });

  test("does not double the newline when the body already ends with one", async () => {
    const path = tempPath();
    const fetch = (async () => new Response(JSONL, { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await client.downloadDataset("d-1", undefined, path, OPTIONS);

    expect(readFileSync(path, "utf8")).toBe(JSONL);
  });

  // An empty body stays empty rather than becoming a file containing one newline,
  // which would parse as a single blank example.
  test("leaves an empty body empty", async () => {
    const path = tempPath();
    const fetch = (async () => new Response("", { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await client.downloadDataset("d-1", undefined, path, OPTIONS);

    expect(readFileSync(path, "utf8")).toBe("");
  });

  // The body is piped to disk rather than buffered, so a dataset larger than
  // memory can still be downloaded. Reading response.text() would defeat this.
  test("streams a multi-chunk body to disk", async () => {
    const path = tempPath();
    const chunks = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'];
    const body = Readable.toWeb(
      Readable.from(chunks.map((c) => new TextEncoder().encode(c))),
    ) as ReadableStream<Uint8Array>;
    const fetch = (async () => new Response(body, { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await client.downloadDataset("d-1", undefined, path, OPTIONS);

    expect(readFileSync(path, "utf8")).toBe(chunks.join(""));
  });

  // Ctrl-C during a long download surfaces as an interruption, not as a service
  // failure, so the exit code and message describe what actually happened.
  test("propagates a caller abort rather than wrapping it as a download error", async () => {
    const path = tempPath();
    const controller = new AbortController();
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError", cause: init?.signal });
    }) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const promise = client.downloadDataset("d-1", undefined, path, OPTIONS, controller.signal);

    await expect(promise).rejects.not.toBeInstanceOf(NetworkingError);
    expect(existsSync(path)).toBe(false);
  });

  // Aborting once the body is already streaming should tear down the write, and stop read
  test("aborts a transfer already in progress, leaving no partial file", async () => {
    const path = tempPath();
    const controller = new AbortController();
    // A body that emits one chunk and then stalls indefinitely.
    const hanging = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"scenario_id":"first"}\n'));
      },
    });
    const fetch = (async () => new Response(hanging, { status: 200 })) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    const promise = client.downloadDataset("d-1", undefined, path, OPTIONS, controller.signal);
    // Abort once the transfer has started rather than before it begins.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(promise).rejects.toThrow();
    // Neither the destination nor a leftover temp file survives the abort.
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  // The caller's signal reaches fetch unchanged, so Ctrl-C cancels an in-flight
  // transfer. The CLI imposes no timeout of its own.
  test("passes the caller's abort signal to fetch", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      received = init?.signal;
      return new Response('{"a":1}\n', { status: 200 });
    }) as CoreFetch;
    const client = new EvalClient(
      stubClients({ datasetId: "d-1", downloadUrl: DOWNLOAD_URL }),
      fetch,
    );

    await client.downloadDataset("d-1", undefined, tempPath(), OPTIONS, controller.signal);

    expect(received).toBe(controller.signal);
  });
});
