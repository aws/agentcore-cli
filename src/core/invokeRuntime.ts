import { randomUUID } from "node:crypto";
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { RuntimeInvokeRequest, RuntimeInvokeResponse } from "../handlers/runtime/types";
import type { Logger } from "../logging";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import { abortable } from "./abortable";
import { toClientConfig } from "./utils";

// InvokeRuntimeDeps is the slice of a Core client an invoke needs. Passed in as a
// bag (not a sibling client) so both RuntimeClient and EvalClient.simulate can call
// these free functions off their own `this.clients`/`this.fetch`/`this.logger`.
export type InvokeRuntimeDeps = {
  clients: AwsClients;
  fetch: CoreFetch;
  logger: Logger;
};

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

// invokeRuntime dispatches by auth mode: a bearer token routes to the CUSTOM_JWT
// (raw fetch) path, otherwise the SigV4 SDK path.
export async function invokeRuntime(
  deps: InvokeRuntimeDeps,
  request: RuntimeInvokeRequest,
  options: CoreOptions,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  const { runtimeId, bearerToken } = request;
  if (bearerToken !== undefined) {
    const logger = deps.logger.child({
      operation: "invokeRuntime",
      authMode: "CUSTOM_JWT",
      runtimeId,
      qualifier: request.qualifier,
      region: options.region,
    });
    return invokeRuntimeWithCustomJwt(deps, request, bearerToken, options, logger, signal);
  }
  return invokeRuntimeWithIam(deps, request, options, signal);
}

async function invokeRuntimeWithCustomJwt(
  deps: InvokeRuntimeDeps,
  request: RuntimeInvokeRequest,
  bearerToken: string,
  options: CoreOptions,
  logger: Logger,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  const client = deps.clients.data(toClientConfig(options));
  const endpoint = client.config.endpointProvider({
    Region: options.region,
    Endpoint: options.endpointUrl,
  });
  const url = new URL(endpoint.url);
  if (url.protocol !== "https:") {
    throw new TypeError("CUSTOM_JWT requires an HTTPS endpoint");
  }
  url.pathname = `${url.pathname.replace(/\/?$/, "/")}runtimes/${encodeURIComponent(request.runtimeId)}/invocations`;
  url.search = new URLSearchParams({
    accountId: request.accountId,
    qualifier: request.qualifier,
  }).toString();
  const headers = new Headers(request.applicationHeaders);
  try {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  } catch {
    throw new TypeError("Invalid bearer token");
  }
  try {
    for (const [name, value] of [
      ["Content-Type", request.contentType],
      ["Accept", request.accept],
      ["Mcp-Session-Id", request.mcpSessionId],
      ["X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", request.runtimeSessionId ?? randomUUID()],
      ["Mcp-Protocol-Version", request.mcpProtocolVersion],
      ["Mcp-Method", request.mcpMethod],
      ["Mcp-Name", request.mcpName],
      ["X-Amzn-Bedrock-AgentCore-Runtime-User-Id", request.runtimeUserId],
      ["X-Amzn-Trace-Id", request.traceId],
      ["traceparent", request.traceParent],
      ["tracestate", request.traceState],
      ["baggage", request.baggage],
    ] as const) {
      if (value !== undefined) headers.set(name, value);
    }
  } catch {
    throw new TypeError("Invalid Runtime request header");
  }
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      redirect: "error",
      headers,
      body: request.payload as RequestInit["body"],
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    logger
      .child({
        errorName:
          error instanceof TypeError
            ? "TypeError"
            : error instanceof Error
              ? "Error"
              : typeof error,
      })
      .debug("Runtime invocation transport failed");
    throw new Error("Runtime invocation failed");
  }
  if (!response.ok) {
    logger
      .child({ httpStatusCode: response.status })
      .debug("Runtime invocation returned a non-success response");
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (response.body as AsyncIterable<Uint8Array> | null) ?? emptyBody();
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") ?? "",
    runtimeSessionId:
      response.headers.get("x-amzn-bedrock-agentcore-runtime-session-id") ?? undefined,
    mcpSessionId: response.headers.get("mcp-session-id") ?? undefined,
    mcpProtocolVersion: response.headers.get("mcp-protocol-version") ?? undefined,
    traceId: response.headers.get("x-amzn-trace-id") ?? undefined,
    traceParent: response.headers.get("traceparent") ?? undefined,
    traceState: response.headers.get("tracestate") ?? undefined,
    baggage: response.headers.get("baggage") ?? undefined,
    body: signal ? abortable(body, signal) : body,
  };
}

async function invokeRuntimeWithIam(
  deps: InvokeRuntimeDeps,
  request: RuntimeInvokeRequest,
  options: CoreOptions,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  const { runtimeId, applicationHeaders, bearerToken: _bearerToken, ...input } = request;
  const command = new InvokeAgentRuntimeCommand({ ...input, agentRuntimeArn: runtimeId });
  if (applicationHeaders?.length) {
    command.middlewareStack.add(
      (next) => async (args) => {
        const sdkRequest = args.request as { headers: Record<string, string> };
        for (const [name, value] of applicationHeaders) sdkRequest.headers[name] = value;
        return next(args);
      },
      { step: "build", name: "runtimeApplicationHeaders" },
    );
  }
  let response;
  try {
    response = await deps.clients.data(toClientConfig(options)).send(command, {
      abortSignal: signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  }

  const body = (response.response as AsyncIterable<Uint8Array> | undefined) ?? emptyBody();
  return {
    statusCode: response.statusCode ?? 0,
    contentType: response.contentType ?? "",
    runtimeSessionId: response.runtimeSessionId,
    mcpSessionId: response.mcpSessionId,
    mcpProtocolVersion: response.mcpProtocolVersion,
    traceId: response.traceId,
    traceParent: response.traceParent,
    traceState: response.traceState,
    baggage: response.baggage,
    body: signal ? abortable(body, signal) : body,
  };
}
