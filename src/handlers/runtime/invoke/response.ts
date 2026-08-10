import { RuntimeInvokeInterruptedError, RuntimeInvokeResponseError } from "../../../errors";
import {
  classifyStreamingResponse,
  writeStreamingResponse,
  writeStreamingResponseFile,
  type StreamingResponseOutput,
} from "../../../io";
import type { RuntimeInvokeResponse } from "../types";

const RESPONSE_STREAM_FAILED = "response stream failed";

export function classifyRuntimeResponse(contentType: string) {
  return classifyStreamingResponse(contentType);
}

export async function writeRuntimeInvokeFile(
  response: RuntimeInvokeResponse,
  path: string,
  signal?: AbortSignal,
  onBytes?: (size: number) => void,
): Promise<void> {
  await writeStreamingResponseFile(response, path, signal, onBytes);
}

function failure(error: unknown): never {
  const interrupted = (error as Error)?.name === "AbortError";
  if (interrupted) throw new RuntimeInvokeInterruptedError(error, true);
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
    `complete=${complete} bytes=${byteCount}${error ? ` error=${error}` : ""}\n`
  );
}

export async function writeRuntimeInvokeResponse(
  response: RuntimeInvokeResponse,
  output: StreamingResponseOutput,
): Promise<void> {
  await writeStreamingResponse(response, output, {
    metadata: ({ body: _body, ...metadata }) => metadata,
    summary,
    fail: failure,
    binaryTtyError: "Binary or unknown response content requires --output-file or --json",
  });
}
