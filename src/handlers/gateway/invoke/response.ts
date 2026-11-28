import { GatewayInvokeResponseError, UserCancellationError } from "../../../errors";
import { writeStreamingResponse, type StreamingResponseOutput } from "../../../io";
import type { GatewayInvokeResponse } from "../types";

const RESPONSE_STREAM_FAILED = "response stream failed";

function failure(error: unknown, signal?: AbortSignal): never {
  const cancellation = UserCancellationError.resolve(error, signal);
  if (cancellation) throw cancellation;
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

/**
 * The hint for an HTTP 403 from an AWS_IAM Gateway. In a Box project, each Box Gateway has a
 * resource policy that denies every principal except its runtime's execution role, so even an
 * administrator gets AccessDenied.
 */
export function gatewayAccessDeniedHint(
  statusCode: number,
  authorizerType: string | undefined,
): string | undefined {
  if (statusCode !== 403 || authorizerType !== "AWS_IAM") return undefined;
  return (
    "Access denied. If this is a Box Gateway (bound to one runtime in a Box project), its " +
    "resource policy lets only that runtime's execution role invoke it. Your credentials " +
    "cannot invoke it, even with administrator access. Otherwise, check that your " +
    "credentials allow bedrock-agentcore:InvokeGateway on this Gateway."
  );
}

export async function writeGatewayInvokeResponse(
  response: GatewayInvokeResponse,
  output: StreamingResponseOutput,
): Promise<void> {
  await writeStreamingResponse(response, output, {
    metadata: ({ body: _body, ...metadata }) => metadata,
    summary,
    fail: (error) => failure(error, output.signal),
    binaryTtyError: "Binary or unknown response content requires --output-file or --json",
  });
}
