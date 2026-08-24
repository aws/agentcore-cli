import { RuntimeInvokeResponseError, UserCancellationError } from "../../../errors";
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
    fail: (error) => failure(error, output.signal),
    binaryTtyError: "Binary or unknown response content requires --output-file or --json",
  });
}
