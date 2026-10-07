import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { AgentCoreCLIError, ERROR_SOURCE, ResourceNotFoundError } from "../../../errors";
import type { HttpRequestHandler, HttpResponse } from "../../../io";
import {
  apiError,
  errorMessage,
  isLoopbackHost,
  parseJsonBody,
  sse,
  sseEvent,
} from "../inspector/respond";
import type { InspectorHarnesses } from "../inspector/types";
import { HarnessInvokeBodySchema } from "./request";

const INVOCATIONS_PATH = /^\/harness\/([^/]+)\/invocations$/;

/** Runs one harness turn and streams its events as SSE, each event mapped by `toEvent`. **/
export async function harnessTurnResponse(
  hosts: Pick<InspectorHarnesses, "invoke">,
  name: string,
  body: unknown,
  signal: AbortSignal,
  toEvent: (event: InvokeHarnessStreamOutput) => unknown,
): Promise<HttpResponse> {
  const parsed = HarnessInvokeBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, `Invalid harness invoke body: ${z.prettifyError(parsed.error)}`);
  }
  try {
    const turn = await hosts.invoke(name, parsed.data, signal);
    return sse(encodeEvents(turn.events, toEvent), turn.sessionId);
  } catch (error) {
    return apiError(harnessErrorStatus(error), errorMessage(error));
  }
}

function harnessErrorStatus(error: unknown): number {
  if (error instanceof ResourceNotFoundError) return 404;
  if (error instanceof AgentCoreCLIError && error.source === ERROR_SOURCE.USER) return 400;
  return 502;
}

export function createHarnessEndpointHandler(
  hosts: Pick<InspectorHarnesses, "invoke">,
): HttpRequestHandler {
  return async (request) => {
    if (!isLoopbackHost(request.headers.host ?? "") || request.headers.origin) {
      return apiError(403, "Forbidden");
    }
    if (request.method !== "POST") return apiError(404, "Not found");
    if (!request.headers["x-agentcore-local"]) {
      return apiError(403, "Forbidden: missing X-Agentcore-Local header");
    }
    const match = INVOCATIONS_PATH.exec(new URL(request.url, "http://localhost").pathname);
    if (!match) return apiError(404, "Not found");

    let name: string;
    try {
      name = decodeURIComponent(match[1]!);
    } catch {
      return apiError(404, "Not found");
    }

    return harnessTurnResponse(
      hosts,
      name,
      parseJsonBody(request.body),
      request.signal,
      (event) => ({ event }),
    );
  };
}

async function* encodeEvents(
  events: AsyncIterable<InvokeHarnessStreamOutput>,
  toEvent: (event: InvokeHarnessStreamOutput) => unknown,
): AsyncGenerator<Uint8Array> {
  for await (const event of events) yield sseEvent(toEvent(event));
}
