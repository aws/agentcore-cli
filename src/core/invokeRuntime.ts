import { randomUUID } from "node:crypto";
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError, NetworkingError } from "../errors";
import type { Logger } from "../logging";
import type { AwsClients, CoreFetch, CoreOptions } from "./types";
import { abortable } from "./abortable";
import { toClientConfig } from "./utils";

// The invoke function lives here and is shared (RuntimeClient + EvalClient call it). Only these
// request/response DTOs are duplicated — not imported from the runtime handler — so each handler
// keeps owning its client-interface types; RuntimeClient passes its identical type through.
export type RuntimeInvokeRequest = {
  runtimeId: string;
  accountId: string;
  qualifier: string;
  payload: Uint8Array;
  contentType: string;
  accept?: string;
  runtimeSessionId?: string;
  runtimeUserId?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
};

export type RuntimeInvokeResponse = {
  statusCode: number;
  contentType: string;
  runtimeSessionId?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
  traceId?: string;
  traceParent?: string;
  traceState?: string;
  baggage?: string;
  error?: RuntimeInvokeErrorResponse;
  body: AsyncIterable<Uint8Array>;
};

export type RuntimeInvokeErrorResponse = {
  detail?: string;
  requestId?: string;
};

// The CUSTOM_JWT path puts the account id in the invocation URL, so a bad ARN must fail here.
export function accountIdFromRuntimeArn(arn: string | undefined): string {
  const id = arn?.match(/^arn:[^:]+:bedrock-agentcore:[^:]*:(\d{12}):runtime\//)?.[1];
  if (!id) throw new InputValidationError("Runtime returned an invalid ARN");
  return id;
}

// InvokeRuntimeDeps is the slice of a Core client an invoke needs. Passed in as a
// bag (not a sibling client) so both RuntimeClient and EvalClient.invokeDataset can call
// these free functions off their own `this.clients`/`this.fetch`/`this.logger`.
export type InvokeRuntimeDeps = {
  clients: AwsClients;
  fetch: CoreFetch;
  logger: Logger;
};

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

class RuntimeErrorResponseReader {
  private static readonly maxBytes = 64 * 1024;
  private static readonly maxDetailCharacters = 1024;

  static forRequest(
    response: Response,
    request: RuntimeInvokeRequest,
    bearerToken: string,
    signal?: AbortSignal,
  ): RuntimeErrorResponseReader {
    return new RuntimeErrorResponseReader(
      response,
      [
        bearerToken,
        ...RuntimeErrorResponseReader.requestValues(request),
        RuntimeErrorResponseReader.textPayload(request.payload),
      ].filter((value): value is string => value !== undefined && value.length > 0),
      signal,
    );
  }

  constructor(
    private readonly response: Response,
    private readonly redactions: string[],
    private readonly signal?: AbortSignal,
  ) {}

  async detail(): Promise<string | undefined> {
    const body = await this.readBody();
    const candidate = body === undefined ? this.response.statusText : this.parse(body);
    return candidate === undefined ? undefined : this.sanitize(candidate);
  }

  header(name: string): string | undefined {
    const value = this.response.headers.get(name);
    return value === null ? undefined : this.sanitize(value, 256);
  }

  private async readBody(): Promise<string | undefined> {
    if (!this.response.body) return undefined;
    const reader = this.response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const read = () => {
      if (!this.signal) return reader.read();
      this.signal.throwIfAborted();
      const signal = this.signal;
      return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        reader
          .read()
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener("abort", onAbort);
          });
      });
    };
    try {
      while (true) {
        const { done, value } = await read();
        if (done) break;
        size += value.byteLength;
        if (size > RuntimeErrorResponseReader.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return undefined;
        }
        chunks.push(value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (this.signal?.aborted) throw this.signal.reason ?? error;
      return undefined;
    } finally {
      reader.releaseLock();
    }
  }

  private parse(body: string): string | undefined {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
    if (typeof parsed === "string") return parsed;
    const root = RuntimeErrorResponseReader.record(parsed);
    if (!root) return undefined;
    const nested = RuntimeErrorResponseReader.record(root.error);
    const type =
      RuntimeErrorResponseReader.string(root, "__type") ??
      RuntimeErrorResponseReader.string(root, "errorType") ??
      RuntimeErrorResponseReader.string(root, "code") ??
      RuntimeErrorResponseReader.string(root, "type") ??
      RuntimeErrorResponseReader.string(nested, "type") ??
      RuntimeErrorResponseReader.string(nested, "code");
    const message =
      RuntimeErrorResponseReader.string(root, "message") ??
      (typeof root.error === "string" ? root.error : undefined) ??
      RuntimeErrorResponseReader.string(root, "detail") ??
      RuntimeErrorResponseReader.string(root, "error_description") ??
      RuntimeErrorResponseReader.string(nested, "message");
    const shortType = type?.split("#").at(-1);
    if (shortType && message && shortType !== message) return `${shortType}: ${message}`;
    return message ?? shortType;
  }

  private sanitize(
    candidate: string,
    maxCharacters = RuntimeErrorResponseReader.maxDetailCharacters,
  ): string | undefined {
    let value = candidate;
    for (const redaction of this.redactions) {
      if (redaction) value = value.split(redaction).join("[REDACTED]");
    }
    value = Array.from(value, (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) return undefined;
    return value.slice(0, maxCharacters);
  }

  private static record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private static string(
    record: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private static requestValues(request: RuntimeInvokeRequest): (string | undefined)[] {
    return [
      ...(request.applicationHeaders?.map(([, value]) => value) ?? []),
      request.runtimeSessionId,
      request.runtimeUserId === "default" ? undefined : request.runtimeUserId,
      request.mcpSessionId,
      request.mcpProtocolVersion,
      request.mcpMethod,
      request.mcpName,
      request.traceId,
      request.traceParent,
      request.traceState,
      request.baggage,
    ];
  }

  private static textPayload(payload: Uint8Array): string | undefined {
    if (payload.byteLength < 4 || payload.byteLength > RuntimeErrorResponseReader.maxBytes) {
      return undefined;
    }
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      return value.trim() ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

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
    throw new InputValidationError("CUSTOM_JWT requires an HTTPS endpoint");
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
    throw new InputValidationError("Invalid bearer token");
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
    throw new InputValidationError("Invalid Runtime request header");
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
    throw new NetworkingError("Runtime invocation failed");
  }
  if (!response.ok) {
    logger
      .child({ httpStatusCode: response.status })
      .debug("Runtime invocation returned a non-success response");
    const errorResponse = RuntimeErrorResponseReader.forRequest(
      response,
      request,
      bearerToken,
      signal,
    );
    const detail = await errorResponse.detail();
    const requestId =
      errorResponse.header("x-amzn-requestid") ?? errorResponse.header("x-amz-request-id");
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
      error: {
        ...(detail !== undefined && { detail }),
        ...(requestId !== undefined && { requestId }),
      },
      body: emptyBody(),
    };
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
