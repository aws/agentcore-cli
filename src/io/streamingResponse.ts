import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export type StreamingResponse = {
  statusCode?: number;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
};

export type StreamingResponseOutput = {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  outputFile?: string;
  json?: boolean;
  signal?: AbortSignal;
};

export type StreamingResponseWriter<T extends StreamingResponse> = {
  metadata: (response: T) => Record<string, unknown>;
  summary: (response: T, byteCount: number, complete: boolean, error?: string) => string;
  fail: (error: unknown) => never;
  binaryTtyError: string;
};

const TEXTUAL_SEQUENCE_MEDIA_TYPES = new Set([
  "application/x-ndjson",
  "application/ndjson",
  "application/json-seq",
]);

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

export function classifyStreamingResponse(contentType: string): "json" | "text" | "binary" {
  const type = mediaType(contentType);
  if (type === "application/json" || /^application\/[^/]+\+json$/.test(type)) {
    return "json";
  }
  return type.startsWith("text/") || TEXTUAL_SEQUENCE_MEDIA_TYPES.has(type) ? "text" : "binary";
}

async function* countBytes(
  body: AsyncIterable<Uint8Array>,
  add: (size: number) => void,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of body) {
    const snapshot = Uint8Array.from(chunk);
    add(snapshot.byteLength);
    yield snapshot;
  }
}

async function writeChunk(
  stream: NodeJS.WriteStream,
  chunk: string | Uint8Array,
  signal: AbortSignal | undefined,
  fail: (error: unknown) => never,
): Promise<void> {
  try {
    await pipeline([chunk], stream, { end: false, signal });
  } catch (error) {
    fail(error);
  }
}

export async function writeStreamingResponseFile(
  response: StreamingResponse,
  path: string,
  signal?: AbortSignal,
  onBytes?: (size: number) => void,
): Promise<void> {
  await pipeline(
    countBytes(response.body, (size) => {
      onBytes?.(size);
    }),
    createWriteStream(path),
    { signal },
  );
}

async function readBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  onBytes: (size: number) => void,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    signal?.throwIfAborted();
    const snapshot = Uint8Array.from(chunk);
    onBytes(snapshot.byteLength);
    chunks.push(snapshot);
  }
  return Buffer.concat(chunks);
}

async function writeJsonResponse<T extends StreamingResponse>(
  response: T,
  bytes: Uint8Array,
  output: StreamingResponseOutput,
  writer: StreamingResponseWriter<T>,
): Promise<void> {
  let bodyEncoding: "utf8" | "base64" = "base64";
  let body = Buffer.from(bytes).toString("base64");

  if (classifyStreamingResponse(response.contentType) !== "binary") {
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      bodyEncoding = "utf8";
    } catch {}
  }

  const envelope = JSON.stringify({
    ...writer.metadata(response),
    bodyEncoding,
    body,
    complete: true,
  });
  await writeChunk(output.stdout, envelope, output.signal, writer.fail);
}

export async function writeStreamingResponse<T extends StreamingResponse>(
  response: T,
  output: StreamingResponseOutput,
  writer: StreamingResponseWriter<T>,
): Promise<void> {
  if (
    output.outputFile === undefined &&
    !output.json &&
    output.stdout.isTTY &&
    response.statusCode !== 204 &&
    response.statusCode !== 205 &&
    classifyStreamingResponse(response.contentType) === "binary"
  ) {
    await writeChunk(output.stderr, writer.summary(response, 0, false), output.signal, writer.fail);
    throw new TypeError(writer.binaryTtyError);
  }

  let byteCount = 0;
  try {
    if (output.outputFile !== undefined) {
      await writeStreamingResponseFile(response, output.outputFile, output.signal, (size) => {
        byteCount += size;
      });
    } else if (output.json) {
      const bytes = await readBody(response.body, output.signal, (size) => {
        byteCount += size;
      });
      await writeJsonResponse(response, bytes, output, writer);
    } else {
      await pipeline(
        countBytes(response.body, (size) => {
          byteCount += size;
        }),
        output.stdout,
        { end: false, signal: output.signal },
      );
    }
  } catch (error) {
    await writeChunk(
      output.stderr,
      writer.summary(
        response,
        byteCount,
        false,
        output.signal?.aborted || (error as Error)?.name === "AbortError"
          ? "interrupted"
          : "response-stream-failed",
      ),
      output.signal,
      writer.fail,
    );
    writer.fail(error);
  }

  if (!output.json) {
    await writeChunk(
      output.stderr,
      writer.summary(response, byteCount, true),
      output.signal,
      writer.fail,
    );
  }
}
