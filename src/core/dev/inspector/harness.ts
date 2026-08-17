/**
 * Deployed-harness invocation routes: POST /invocations with a harnessName in
 * the body, and POST /api/harness/tool-response. Both stream harness events
 * back as `data: <json>` SSE frames, per the reference harness handlers.
 */
import { randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import type { HarnessInvocationOverrides, HarnessMessage } from "./api";
import { asString } from "./invocations";
import { apiError, errorMessage, parseJsonBody, sse, sseEvent } from "./respond";
import type { InspectorDeps, InspectorHarness } from "./types";

/** POST /invocations with `harnessName` — invoke a deployed harness with one user prompt. */
export async function handleHarnessInvocation(
  deps: InspectorDeps,
  body: Record<string, unknown>,
): Promise<HttpResponse> {
  const harness = deps.aws?.harness;
  if (!harness) return apiError(404, "Harness invocation is not available");

  const harnessName = asString(body.harnessName);
  if (!harnessName) return apiError(400, "harnessName is required");
  const prompt = asString(body.prompt);
  if (!prompt) return apiError(400, "prompt is required");

  const sessionId = asString(body.sessionId) || randomUUID();
  return invokeHarness(harness, {
    harnessName,
    sessionId,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    userId: asString(body.userId),
    overrides: body.harnessOverrides as HarnessInvocationOverrides | undefined,
  });
}

/** POST /api/harness/tool-response — continue a harness session with tool results. */
export async function handleHarnessToolResponse(
  deps: InspectorDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const harness = deps.aws?.harness;
  if (!harness) return apiError(404, "Harness invocation is not available");

  const raw = parseJsonBody(request.body);
  if (!raw) return apiError(400, "Invalid JSON");
  const harnessName = asString(raw.harnessName);
  if (!harnessName) return apiError(400, "harnessName is required");
  if (!Array.isArray(raw.messages)) return apiError(400, "messages array is required");
  const sessionId = asString(raw.sessionId);
  if (!sessionId) return apiError(400, "sessionId is required");

  return invokeHarness(harness, {
    harnessName,
    sessionId,
    messages: raw.messages as HarnessMessage[],
    overrides: raw.harnessOverrides as HarnessInvocationOverrides | undefined,
  });
}

async function invokeHarness(
  harness: InspectorHarness,
  request: {
    harnessName: string;
    sessionId: string;
    messages: HarnessMessage[];
    userId?: string;
    overrides?: HarnessInvocationOverrides;
  },
): Promise<HttpResponse> {
  let stream: AsyncIterable<unknown>;
  try {
    stream = await harness.invoke(request);
  } catch (error) {
    // Rejected before any event streamed (e.g. unknown harness): a JSON error
    // is still possible, matching the reference's pre-stream 404.
    return apiError(404, errorMessage(error));
  }
  return sse(frameHarnessStream(stream), request.sessionId);
}

async function* frameHarnessStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<Uint8Array, void> {
  try {
    for await (const event of stream) yield sseEvent(event);
  } catch (error) {
    yield sseEvent({ type: "error", errorType: "invocationError", message: errorMessage(error) });
  }
}
