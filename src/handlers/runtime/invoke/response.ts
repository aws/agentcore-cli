import { pipeline } from "node:stream/promises";
import { RuntimeInvokeResponseError, UserCancellationError } from "../../../errors";
import {
  classifyStreamingResponse,
  writeStreamingResponse,
  writeStreamingResponseFile,
  type StreamingResponseOutput,
} from "../../../io";
import type {
  RuntimeInvokeRejectedResponse,
  RuntimeInvokeResponse,
  RuntimeInvokeStreamResponse,
} from "../types";

const RESPONSE_STREAM_FAILED = "response stream failed";

export function classifyRuntimeResponse(contentType: string) {
  return classifyStreamingResponse(contentType);
}

export async function writeRuntimeInvokeFile(
  response: RuntimeInvokeStreamResponse,
  path: string,
  signal?: AbortSignal,
  onBytes?: (size: number) => void,
): Promise<void> {
  await writeStreamingResponseFile(response, path, signal, onBytes);
}

function failure(error: unknown, signal?: AbortSignal): never {
  const cancellation = UserCancellationError.resolve(error, signal);
  if (cancellation) throw cancellation;
  throw new RuntimeInvokeResponseError(RESPONSE_STREAM_FAILED, error);
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
    `complete=${complete} bytes=${byteCount}${error ? ` error=${error}` : ""}` +
    `${response.kind === "rejected" && response.error.requestId ? ` request-id=${response.error.requestId}` : ""}\n`
  );
}

async function writeRejectedRuntimeResponse(
  response: RuntimeInvokeRejectedResponse,
  output: StreamingResponseOutput,
): Promise<never> {
  try {
    await output.beforeOutput?.();
    await pipeline([summary(response, 0, false, `HTTP ${response.statusCode}`)], output.stderr, {
      end: false,
      signal: output.signal,
    });
  } catch (error) {
    failure(error, output.signal);
  }
  throw new RuntimeInvokeResponseError(`HTTP ${response.statusCode}`);
}

export async function writeRuntimeInvokeResponse(
  response: RuntimeInvokeResponse,
  output: StreamingResponseOutput,
): Promise<void> {
  if (response.kind === "rejected") return writeRejectedRuntimeResponse(response, output);
  await writeStreamingResponse(response, output, {
    metadata: ({ body: _body, kind: _kind, ...metadata }) => metadata,
    summary,
    fail: (error) => failure(error, output.signal),
    binaryTtyError: "Binary or unknown response content requires --output-file or --json",
  });
}
