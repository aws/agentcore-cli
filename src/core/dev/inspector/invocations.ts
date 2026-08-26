// Every upstream fetch carries the client abort signal, so a browser disconnect tears down the agent request.
import { randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import {
  apiError,
  asString,
  errorMessage,
  iterateBody,
  parseJsonBody,
  sse,
  sseData,
  sseEvent,
} from "./respond";
import type { InspectorDeps } from "./types";

export async function handleInvocations(
  deps: InspectorDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const parsed = parseJsonBody(request.body);
  const agentName = asString(parsed?.agentName);
  // Request header, agent body, and echoed x-session-id must agree, so one session id is computed once.
  const sessionId = asString(parsed?.sessionId) ?? randomUUID();
  const userId = asString(parsed?.userId);
  const signal = request.signal;

  let running = agentName ? deps.supervisor.running(agentName) : undefined;
  if (!running) {
    const first = deps.supervisor.snapshot().find((agent) => agent.phase === "running");
    if (first) running = deps.supervisor.running(first.name);
  }
  if (!running) return apiError(409, "No agent is running. Call POST /api/start first.");

  if (running.protocol === "MCP") {
    return apiError(400, "MCP agents are invoked through POST /api/mcp, not /invocations.");
  }
  if (running.protocol === "A2A") {
    return invokeA2aAgent(running.port, parsed, sessionId, signal);
  }
  if (running.protocol === "AGUI") {
    return invokeAguiAgent(running.port, parsed, sessionId, userId, signal);
  }
  return invokeHttpAgent(running.port, request.body, sessionId, userId, signal);
}

async function forwardInvocation(
  port: number,
  body: Buffer | string,
  sessionId: string,
  userId: string | undefined,
  signal: AbortSignal,
  options: { accept: string; normalizeSse: boolean },
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: options.accept,
    "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
  };
  if (userId) headers["x-amzn-bedrock-agentcore-runtime-user-id"] = userId;

  let agentResponse: Response;
  try {
    agentResponse = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    return apiError(502, `Agent server error: ${errorMessage(error)}`);
  }

  const contentType = agentResponse.headers.get("content-type") ?? "text/plain";
  const stream = iterateBody(agentResponse.body);
  return {
    status: agentResponse.status,
    headers: { "Content-Type": contentType, "x-session-id": sessionId },
    body:
      options.normalizeSse && contentType.includes("text/event-stream")
        ? transformAgentSse(stream)
        : stream,
  };
}

function invokeHttpAgent(
  port: number,
  body: Buffer,
  sessionId: string,
  userId: string | undefined,
  signal: AbortSignal,
): Promise<HttpResponse> {
  return forwardInvocation(port, body, sessionId, userId, signal, {
    accept: "text/event-stream, */*",
    normalizeSse: true,
  });
}

async function* transformAgentSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  for await (const data of sseData(stream)) {
    const payload = parseAgentEvent(data);
    if (payload !== null) yield sseEvent(payload);
  }
}

// Handles bedrock {text}, {error}, ConverseStream contentBlockDelta, bare JSON string, and non-JSON tokens.
export function parseAgentEvent(data: string): string | { error: string } | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "string") return parsed || null;
    if (parsed && typeof parsed === "object") {
      if ("error" in parsed) {
        const error = String((parsed as { error: unknown }).error);
        return error ? { error } : null;
      }
      if ("text" in parsed) return String((parsed as { text: unknown }).text) || null;
      const event = (parsed as { event?: { contentBlockDelta?: { delta?: { text?: string } } } })
        .event;
      return event?.contentBlockDelta?.delta?.text || null;
    }
  } catch {
    return data || null;
  }
  return null;
}

// A2A agents speak JSON-RPC at their root path, so {prompt} becomes a message/stream call reduced to text frames.
async function invokeA2aAgent(
  port: number,
  body: Record<string, unknown> | undefined,
  sessionId: string,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const prompt = asString(body?.prompt);
  if (!prompt) return apiError(400, "prompt is required");

  const a2aBody = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/stream",
    params: {
      message: {
        messageId: randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: prompt }],
        contextId: sessionId,
      },
    },
  };

  let agentResponse: Response;
  try {
    agentResponse = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(a2aBody),
      signal,
    });
  } catch (error) {
    return apiError(502, `A2A agent error: ${errorMessage(error)}`);
  }
  if (!agentResponse.ok) return apiError(502, `A2A agent returned ${agentResponse.status}`);

  const contentType = agentResponse.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && agentResponse.body) {
    return sse(transformA2aSse(iterateBody(agentResponse.body)), sessionId);
  }

  const responseText = await agentResponse.text();
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const result = parsed.result as Record<string, unknown> | undefined;
    const text = result
      ? (extractTaskText(result) ?? JSON.stringify(result, null, 2))
      : responseText;
    return {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "x-session-id": sessionId },
      body: Buffer.from(sseEvent(text)),
    };
  } catch {
    return { status: 200, headers: { "Content-Type": "text/plain" }, body: responseText };
  }
}

async function* transformA2aSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  let streamedFromStatus = false;
  for await (const data of sseData(stream)) {
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const text = extractSseEventText(event, streamedFromStatus);
      if (text) {
        if (isStatusUpdateEvent(event)) streamedFromStatus = true;
        yield sseEvent(text);
      }
    } catch {
      yield sseEvent(data);
    }
  }
}

function isStatusUpdateEvent(event: Record<string, unknown>): boolean {
  const target = (event.result as Record<string, unknown>) ?? event;
  return target.kind === "status-update";
}

// When streamedFromStatus is set, artifact-update text is skipped because status-update already streamed it.
function extractSseEventText(
  event: Record<string, unknown>,
  streamedFromStatus: boolean,
): string | null {
  const target = (event.result as Record<string, unknown>) ?? event;
  const kind = target.kind as string | undefined;

  if (kind === "artifact-update") {
    if (streamedFromStatus) return null;
    const artifact = target.artifact as { parts?: A2aPart[] } | undefined;
    return extractPartsText(artifact?.parts);
  }

  if (kind === "status-update") {
    const status = target.status as { message?: { parts?: A2aPart[] } } | undefined;
    if (status?.message?.parts) return extractPartsText(status.message.parts);
    return null;
  }

  return extractTaskText(target);
}

function extractTaskText(result: Record<string, unknown>): string | null {
  const artifacts = result.artifacts as { parts?: A2aPart[] }[] | undefined;
  if (artifacts) {
    const texts: string[] = [];
    for (const artifact of artifacts) {
      const text = extractPartsText(artifact.parts);
      if (text) texts.push(text);
    }
    if (texts.length > 0) return texts.join("\n");
  }

  const status = result.status as { message?: { parts?: A2aPart[] } } | undefined;
  if (status?.message?.parts) return extractPartsText(status.message.parts);
  return null;
}

type A2aPart = { kind?: string; type?: string; text?: string };

function extractPartsText(parts: A2aPart[] | undefined): string | null {
  if (!parts) return null;
  const texts: string[] = [];
  for (const part of parts) {
    if ((part.kind === "text" || part.type === "text") && part.text) texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("") : null;
}

// AGUI agents expect a RunAgentInput body, and the typed AG-UI SSE response passes through untouched.
function invokeAguiAgent(
  port: number,
  body: Record<string, unknown> | undefined,
  sessionId: string,
  userId: string | undefined,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const prompt = asString(body?.prompt);
  if (!prompt) return Promise.resolve(apiError(400, "prompt is required"));

  const aguiBody = JSON.stringify({
    threadId: sessionId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });

  return forwardInvocation(port, aguiBody, sessionId, userId, signal, {
    accept: "text/event-stream",
    normalizeSse: false,
  });
}
