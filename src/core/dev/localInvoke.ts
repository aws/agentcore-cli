import { randomUUID } from "node:crypto";
import { InputValidationError, InvalidEnvironmentError } from "../../errors";
import type { ProtocolMode } from "../../projectSchemas/constants";
import { abortable } from "../abortable";
import type { RuntimeInvokeResponse } from "../invokeRuntime";

export type LocalRuntimeInvokeRequest = {
  port: number;
  protocol: ProtocolMode;
  payload: Uint8Array;
  contentType?: string;
  accept?: string;
  runtimeSessionId?: string;
  runtimeUserId?: string;
  applicationHeaders?: [string, string][];
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
};

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

function invocationPath(protocol: ProtocolMode): string {
  if (protocol === "MCP") return "/mcp";
  if (protocol === "A2A") return "/";
  return "/invocations";
}

export async function invokeLocalRuntime(
  request: LocalRuntimeInvokeRequest,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  const runtimeSessionId = request.runtimeSessionId ?? randomUUID();
  let headers: Headers;
  try {
    headers = new Headers(request.applicationHeaders);
    for (const [name, value] of [
      ["Content-Type", request.contentType ?? "application/json"],
      [
        "Accept",
        request.accept ??
          (request.protocol === "MCP"
            ? "application/json, text/event-stream"
            : "text/event-stream"),
      ],
      ["Mcp-Session-Id", request.mcpSessionId],
      ["Mcp-Protocol-Version", request.mcpProtocolVersion],
      ["Mcp-Method", request.mcpMethod],
      ["Mcp-Name", request.mcpName],
      ["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", runtimeSessionId],
      ["X-Amzn-Bedrock-AgentCore-Runtime-User-Id", request.runtimeUserId ?? "default"],
      ["X-Amzn-Trace-Id", request.traceId],
      ["traceparent", request.traceParent],
      ["tracestate", request.traceState],
      ["baggage", request.baggage],
    ] as const) {
      if (value !== undefined) headers.set(name, value);
    }
  } catch {
    throw new InputValidationError("Invalid local Runtime request header");
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${request.port}${invocationPath(request.protocol)}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: request.payload as RequestInit["body"],
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidEnvironmentError(
      `Could not reach local dev server on port ${request.port} (${detail}). Start it with: ` +
        `agentcore dev --mode headless --agent <name> --port ${request.port}`,
      { cause: error },
    );
  }

  const body = (response.body as AsyncIterable<Uint8Array> | null) ?? emptyBody();
  return {
    kind: "stream",
    statusCode: response.status,
    contentType: response.headers.get("content-type") ?? "",
    runtimeSessionId:
      response.headers.get("x-amzn-bedrock-agentcore-runtime-session-id") ?? runtimeSessionId,
    mcpSessionId: response.headers.get("mcp-session-id") ?? undefined,
    mcpProtocolVersion: response.headers.get("mcp-protocol-version") ?? undefined,
    traceId: response.headers.get("x-amzn-trace-id") ?? undefined,
    traceParent: response.headers.get("traceparent") ?? undefined,
    traceState: response.headers.get("tracestate") ?? undefined,
    baggage: response.headers.get("baggage") ?? undefined,
    body: signal ? abortable(body, signal) : body,
  };
}
