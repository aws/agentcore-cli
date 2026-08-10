import { GatewayInvokeInterruptedError, GatewayInvokeResponseError } from "../../../errors";
import { writeStreamingResponse, type StreamingResponseOutput } from "../../../io";
import type { GatewayInvokeResponse } from "../types";

const RESPONSE_STREAM_FAILED = "response stream failed";

function failure(error: unknown): never {
  const interrupted = (error as Error)?.name === "AbortError";
  if (interrupted) throw new GatewayInvokeInterruptedError(error, true);
  throw new GatewayInvokeResponseError(RESPONSE_STREAM_FAILED, error);
}

function summary(
  response: GatewayInvokeResponse,
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
    `request-id=${value(response.requestId)} ` +
    `complete=${complete} bytes=${byteCount}${error ? ` error=${error}` : ""}\n`
  );
}

export async function writeGatewayInvokeResponse(
  response: GatewayInvokeResponse,
  output: StreamingResponseOutput,
): Promise<void> {
  await writeStreamingResponse(response, output, {
    metadata: ({ body: _body, ...metadata }) => metadata,
    summary,
    fail: failure,
    binaryTtyError: "Binary or unknown response content requires --output-file or --json",
  });
}
