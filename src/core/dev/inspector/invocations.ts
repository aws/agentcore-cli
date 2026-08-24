/**
 * POST /invocations — the protocol-aware proxy to a locally running agent.
 * Ported from the reference web-ui/handlers/invocations.ts; the SSE framing
 * (`data: <json>\n\n`) is part of the SPA wire contract. Every upstream fetch
 * carries the client's abort signal so a browser disconnect tears down the
 * agent request instead of leaking it.
 */
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
  nextA2aId: () => number,
): Promise<HttpResponse> {
  const parsed = parseJsonBody(request.body);
  const agentName = asString(parsed?.agentName);
  // One session id for the whole exchange: request header, agent body, and the
  // echoed x-session-id must agree, so it is computed once here.
  const sessionId = asString(parsed?.sessionId) ?? randomUUID();
  const userId = asString(parsed?.userId);
  const signal = request.signal;

  // Route to the named agent, falling back to the first running one.
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
    return invokeA2aAgent(running.port, parsed, sessionId, nextA2aId, signal);
  }
  if (running.protocol === "AGUI") {
    return invokeAguiAgent(running.port, parsed, sessionId, userId, signal);
  }
  return invokeHttpAgent(running.port, request.body, sessionId, userId, signal);
}

/** Forward to the agent's /invocations route, normalizing SSE events to plain text. */
async function invokeHttpAgent(
  port: number,
  body: Buffer,
  sessionId: string,
  userId: string | undefined,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, */*",
    "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
  };
  if (userId) headers["x-amzn-bedrock-agentcore-runtime-user-id"] = userId;

  let agentResponse: Response;
  try {
    agentResponse = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      headers,
      body: body.toString(),
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
    body: contentType.includes("text/event-stream") ? transformAgentSse(stream) : stream,
  };
}

/** Re-frame each agent SSE event through {@link parseAgentEvent}. */
async function* transformAgentSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  for await (const data of sseData(stream)) {
    const { content, error } = parseAgentEvent(data);
    if (error) yield sseEvent({ error });
    else if (content) yield sseEvent(content);
  }
}

/**
 * Extract displayable text from one agent SSE `data` payload. Handles plain
 * strings, `{"text": ...}` events from the bedrock-agentcore runtime,
 * `{"error": ...}` events, and ConverseStream-shaped content deltas. A payload
 * that is not JSON is a plain-text token, forwarded unchanged.
 */
export function parseAgentEvent(data: string): { content: string | null; error: string | null } {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "string") return { content: parsed, error: null };
    if (parsed && typeof parsed === "object") {
      if ("error" in parsed) {
        return { content: null, error: String((parsed as { error: unknown }).error) };
      }
      if ("text" in parsed) {
        return { content: String((parsed as { text: unknown }).text), error: null };
      }
      const event = (parsed as { event?: { contentBlockDelta?: { delta?: { text?: string } } } })
        .event;
      const text = event?.contentBlockDelta?.delta?.text;
      if (typeof text === "string") return { content: text, error: null };
    }
  } catch {
    return { content: data, error: null };
  }
  return { content: null, error: null };
}

/**
 * A2A agents speak JSON-RPC at their root path: translate the SPA's
 * `{ prompt }` payload into `message/stream` and reduce the A2A event stream
 * to the `data: "text"` frames the SPA's chat expects.
 */
async function invokeA2aAgent(
  port: number,
  body: Record<string, unknown> | undefined,
  sessionId: string,
  nextA2aId: () => number,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const prompt = asString(body?.prompt);
  if (!prompt) return apiError(400, "prompt is required");

  const a2aBody = {
    jsonrpc: "2.0",
    id: nextA2aId(),
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

  // Non-streaming fallback: extract text from the JSON-RPC result.
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

/**
 * Extract displayable text from an A2A SSE event (artifact-update or
 * status-update, optionally wrapped in a JSON-RPC result envelope). When
 * `streamedFromStatus` is set, artifact-update text is skipped because the
 * same content already streamed incrementally via status-update events.
 */
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

/** Extract text from a full A2A Task result (artifacts array and/or status message). */
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

/**
 * AGUI agents expect a RunAgentInput body; translate the SPA's `{ prompt }`
 * payload and pass the typed AG-UI SSE response through untouched.
 */
async function invokeAguiAgent(
  port: number,
  body: Record<string, unknown> | undefined,
  sessionId: string,
  userId: string | undefined,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const prompt = asString(body?.prompt);
  if (!prompt) return apiError(400, "prompt is required");

  const aguiBody = JSON.stringify({
    threadId: sessionId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
  };
  if (userId) headers["x-amzn-bedrock-agentcore-runtime-user-id"] = userId;

  let agentResponse: Response;
  try {
    agentResponse = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      headers,
      body: aguiBody,
      signal,
    });
  } catch (error) {
    return apiError(502, `AGUI agent error: ${errorMessage(error)}`);
  }

  return {
    status: agentResponse.status,
    headers: {
      "Content-Type": agentResponse.headers.get("content-type") ?? "text/plain",
      "x-session-id": sessionId,
    },
    body: iterateBody(agentResponse.body),
  };
}
