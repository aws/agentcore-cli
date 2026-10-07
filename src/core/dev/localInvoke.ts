import { randomUUID } from "node:crypto";
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  InvalidEnvironmentError,
} from "../../errors";
import type { ProtocolMode } from "../../projectSchemas/constants";
import { abortable } from "../abortable";
import type { RuntimeInvokeResponse } from "../invokeRuntime";
import { harnessEvents } from "./harness/request";
import { errorMessage, iterateBody } from "./inspector/respond";

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
    throw new InvalidEnvironmentError(
      `Could not reach local dev server on port ${request.port} (${errorMessage(error)}). Start it with: ` +
        `agentcore dev --mode headless --agent <name> --port ${request.port}`,
      { cause: error },
    );
  }

  const body = (response.body as AsyncIterable<Uint8Array> | null) ?? emptyBody();
  return {
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

export async function invokeLocalHarness(
  request: { port: number; name: string; prompt: string; sessionId?: string },
  signal?: AbortSignal,
): Promise<{ sessionId: string; events: AsyncGenerator<InvokeHarnessStreamOutput> }> {
  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${request.port}/harness/${encodeURIComponent(request.name)}/invocations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agentcore-Local": "1" },
        body: JSON.stringify({ prompt: request.prompt, sessionId: request.sessionId }),
        signal,
      },
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new InvalidEnvironmentError(
      `Could not reach the local harness endpoint on port ${request.port} (${errorMessage(error)}). Start it with: ` +
        `agentcore dev --harness ${request.name} --port ${request.port}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new AgentCoreCLIError(message, {
      source: response.status < 500 ? ERROR_SOURCE.USER : ERROR_SOURCE.SERVICE,
    });
  }
  const body = iterateBody(response.body);
  return {
    sessionId: response.headers.get("x-session-id")!,
    events: harnessEvents(signal ? abortable(body, signal) : body),
  };
}
