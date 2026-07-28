import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { RuntimeInvokeResponse } from "../types";
import { RuntimeInvokeInterruptedError, RuntimeInvokeResponseError, UsageError } from "./errors";

interface RuntimeInvokeOutput {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  outputFile?: string;
  json?: boolean;
  signal?: AbortSignal;
}

const RESPONSE_STREAM_FAILED = "response stream failed";
const STREAMING_MEDIA_TYPES = new Set([
  "text/event-stream",
  "application/x-ndjson",
  "application/ndjson",
  "application/json-seq",
]);

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

export function isStreamingRuntimeResponse(contentType: string): boolean {
  return STREAMING_MEDIA_TYPES.has(mediaType(contentType));
}

export function classifyRuntimeResponse(contentType: string) {
  const type = mediaType(contentType);
  if (type === "application/json" || /^application\/[^/]+\+json$/.test(type)) {
    return "json";
  }
  return type.startsWith("text/") || STREAMING_MEDIA_TYPES.has(type) ? "text" : "binary";
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
  signal?: AbortSignal,
): Promise<void> {
  try {
    await pipeline([chunk], stream, { end: false, signal });
  } catch (error) {
    failure(error);
  }
}

export async function writeRuntimeInvokeFile(
  response: RuntimeInvokeResponse,
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

function failure(error: unknown): never {
  const interrupted = (error as Error)?.name === "AbortError";
  if (interrupted) throw new RuntimeInvokeInterruptedError(error, true);
  throw new RuntimeInvokeResponseError(RESPONSE_STREAM_FAILED, error);
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

async function writeJsonResponse(
  response: RuntimeInvokeResponse,
  bytes: Uint8Array,
  output: RuntimeInvokeOutput,
): Promise<void> {
  const { body: _body, ...responseMetadata } = response;
  let bodyEncoding: "utf8" | "base64" = "base64";
  let body = Buffer.from(bytes).toString("base64");

  if (classifyRuntimeResponse(response.contentType) !== "binary") {
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      bodyEncoding = "utf8";
    } catch {}
  }

  const envelope = JSON.stringify({
    ...responseMetadata,
    bodyEncoding,
    body,
    complete: true,
  });
  await writeChunk(output.stdout, envelope, output.signal);
}

function summary(
  response: RuntimeInvokeResponse,
  byteCount: number,
  complete: boolean,
  error?: string,
): string {
  const value = (item?: string) => item || "-";
  return (
    `status=${response.statusCode} content-type=${value(response.contentType)} ` +
    `runtime-session-id=${value(response.runtimeSessionId)} ` +
    `mcp-session-id=${value(response.mcpSessionId)} ` +
    `mcp-protocol-version=${value(response.mcpProtocolVersion)} ` +
    `trace-id=${value(response.traceId)} trace-parent=${value(response.traceParent)} ` +
    `trace-state=${value(response.traceState)} baggage=${value(response.baggage)} ` +
    `complete=${complete} bytes=${byteCount}${error ? ` error=${error}` : ""}\n`
  );
}

export async function writeRuntimeInvokeResponse(
  response: RuntimeInvokeResponse,
  output: RuntimeInvokeOutput,
): Promise<void> {
  const streaming = isStreamingRuntimeResponse(response.contentType);
  if (output.json && streaming) {
    throw new UsageError(
      "--json cannot be used with a streaming Runtime response; omit --json or use --output-file",
    );
  }

  if (
    output.outputFile === undefined &&
    output.stdout.isTTY &&
    classifyRuntimeResponse(response.contentType) === "binary"
  ) {
    await writeChunk(output.stderr, summary(response, 0, false));
    throw new TypeError("Binary or unknown response content requires --output-file or --json");
  }

  let byteCount = 0;
  try {
    if (output.outputFile !== undefined) {
      await writeRuntimeInvokeFile(
        response,
        output.outputFile,
        output.signal,
        (size) => (byteCount += size),
      );
    } else if (streaming) {
      await pipeline(
        countBytes(response.body, (size) => (byteCount += size)),
        output.stdout,
        { end: false, signal: output.signal },
      );
    } else {
      const bytes = await readBody(response.body, output.signal, (size) => (byteCount += size));
      if (output.json) {
        await writeJsonResponse(response, bytes, output);
      } else {
        await writeChunk(output.stdout, bytes, output.signal);
      }
    }
  } catch (error) {
    await writeChunk(
      output.stderr,
      summary(
        response,
        byteCount,
        false,
        (error as Error)?.name === "AbortError" ? "interrupted" : "response-stream-failed",
      ),
    );
    failure(error);
  }
  if (!output.json) {
    await writeChunk(output.stderr, summary(response, byteCount, true));
  }
}
