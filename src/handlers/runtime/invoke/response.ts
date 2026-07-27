import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { RuntimeInvokeResponse } from "../types";

interface RuntimeInvokeOutput {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  outputFile?: string;
  json?: boolean;
  signal?: AbortSignal;
}

const RESPONSE_STREAM_FAILED = "response stream failed";

export function classifyRuntimeResponse(contentType: string) {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "application/json" || /^application\/[^/]+\+json$/.test(mediaType)) {
    return "json";
  }
  return mediaType.startsWith("text/") ? "text" : "binary";
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

async function writeText(
  stream: NodeJS.WriteStream,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await pipeline([text], stream, { end: false, signal });
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
  const reported = new Error(interrupted ? "The operation was aborted" : RESPONSE_STREAM_FAILED);
  reported.name = interrupted ? "AbortError" : "Error";
  Object.assign(reported, { reported: true });
  throw reported;
}

async function writeJsonResponse(
  response: RuntimeInvokeResponse,
  output: RuntimeInvokeOutput,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let streamError: unknown;
  try {
    for await (const chunk of response.body) {
      output.signal?.throwIfAborted();
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error) {
    streamError = error;
  }
  const bytes = Buffer.concat(chunks);
  const { body: _body, ...responseMetadata } = response;
  let bodyEncoding: "utf8" | "base64" = "base64";
  let body = bytes.toString("base64");

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
    complete: streamError === undefined,
    ...(streamError !== undefined && {
      error: (streamError as Error)?.name === "AbortError" ? "interrupted" : RESPONSE_STREAM_FAILED,
    }),
  });
  await writeText(output.stdout, envelope, streamError === undefined ? output.signal : undefined);
  if (streamError !== undefined) failure(streamError);
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
  if (output.json) {
    await writeJsonResponse(response, output);
    return;
  }

  if (
    output.outputFile === undefined &&
    output.stdout.isTTY &&
    classifyRuntimeResponse(response.contentType) === "binary"
  ) {
    await writeText(output.stderr, summary(response, 0, false));
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
    } else {
      await pipeline(
        countBytes(response.body, (size) => (byteCount += size)),
        output.stdout,
        { end: false, signal: output.signal },
      );
    }
  } catch (error) {
    await writeText(
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
  await writeText(output.stderr, summary(response, byteCount, true));
}
