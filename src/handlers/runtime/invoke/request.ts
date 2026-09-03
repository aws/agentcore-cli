import { validateHeaderName, validateHeaderValue } from "node:http";
import z from "zod";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, SourceResolutionError } from "../../../errors";
import { SourceResolver } from "../../../io";
import type { RuntimeInvokeRequest } from "../types";

export const runtimeIdSchema = z
  .string()
  .refine((value) => !value.startsWith("arn:"), "must be a Runtime ID, not an ARN");

export type RuntimeInvokeInput = Omit<
  RuntimeInvokeRequest,
  "accountId" | "qualifier" | "contentType"
> &
  Partial<Pick<RuntimeInvokeRequest, "qualifier" | "contentType">>;

const DEFAULT_RUNTIME_USER_ID = "default";
const CUSTOM_HEADER_PREFIX = "x-amzn-bedrock-agentcore-runtime-custom-";
const RESERVED_HEADERS = new Set([
  "authorization",
  "accept",
  "content-length",
  "content-type",
  "host",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-amzn-bedrock-agentcore-runtime-session-id",
  "x-amzn-bedrock-agentcore-runtime-user-id",
  "x-amzn-trace-id",
  "traceparent",
  "tracestate",
  "baggage",
]);

export async function resolveRuntimeInvokeSources(
  sources: { payload: string; bearerToken?: string },
  stdin: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<{ payload: Uint8Array; bearerToken?: string }> {
  if (sources.payload === "-" && sources.bearerToken === "-") {
    throw new InputValidationError("Payload and bearer token cannot both read from stdin");
  }

  const resolver = new SourceResolver({ stdin, signal });
  try {
    const payload = await resolver.resolveBytes("payload", sources.payload);
    const bearerToken = await resolver.resolveText("bearer-token", sources.bearerToken);
    return {
      payload: payload!,
      ...(bearerToken !== undefined && { bearerToken }),
    };
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      throw new InputValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

export async function resolveRuntimeInvokeTuiBearerToken(
  source: string | undefined,
  stdin: NodeJS.ReadStream,
): Promise<string | undefined> {
  if (source === "-") {
    throw new InputValidationError(
      "stdin bearer tokens are not available when launching the interactive console",
    );
  }
  try {
    return await new SourceResolver({ stdin }).resolveText("bearer-token", source);
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      throw new InputValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

export function parseRuntimeInvokeHeaders(values: string[] = []): [string, string][] {
  const seen = new Set<string>();

  return values.map((header) => {
    const separator = header.indexOf(":");
    if (separator < 1) throw new InputValidationError("Header must use 'Name: value' format");
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    try {
      validateHeaderName(name);
    } catch {
      throw new InputValidationError(
        `Invalid HTTP header name: ${name} (must use valid HTTP token characters)`,
      );
    }
    try {
      validateHeaderValue(name, value);
    } catch {
      throw new InputValidationError(
        `Invalid header value for ${name}: contains a character not allowed in HTTP headers`,
      );
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new InputValidationError(`Duplicate header: ${name}`);
    seen.add(lower);
    if (RESERVED_HEADERS.has(lower))
      throw new InputValidationError(`Application header is reserved: ${name}`);
    return [name, value];
  });
}

function validateAllowedHeaders(
  detail: GetAgentRuntimeResponse,
  headers: [string, string][],
): void {
  const allowlist =
    detail.requestHeaderConfiguration &&
    "requestHeaderAllowlist" in detail.requestHeaderConfiguration
      ? (detail.requestHeaderConfiguration.requestHeaderAllowlist ?? []).map((name) =>
          name.toLowerCase(),
        )
      : [];
  for (const [name] of headers) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(CUSTOM_HEADER_PREFIX) && !allowlist.includes(lower)) {
      throw new InputValidationError(`Application header is not allowed: ${name}`);
    }
  }
}

export function normalizeRuntimeInvokeRequest(
  detail: GetAgentRuntimeResponse,
  input: RuntimeInvokeInput,
): RuntimeInvokeRequest {
  const accountId = detail.agentRuntimeArn?.match(
    /^arn:[^:]+:bedrock-agentcore:[^:]*:(\d{12}):runtime\//,
  )?.[1];
  if (!accountId) {
    throw new InputValidationError("Runtime returned an invalid ARN");
  }

  const authorizer = detail.authorizerConfiguration;
  const customJwt = authorizer !== undefined && "customJWTAuthorizer" in authorizer;
  if (authorizer && !customJwt)
    throw new InputValidationError("Runtime uses an unsupported authorizer");
  const { runtimeId, qualifier, payload, contentType, applicationHeaders = [], ...modeled } = input;
  if (customJwt && !modeled.bearerToken) {
    throw new InputValidationError("CUSTOM_JWT Runtime requires --bearer-token");
  }
  if (!customJwt && modeled.bearerToken !== undefined) {
    throw new InputValidationError("IAM Runtime does not accept --bearer-token");
  }

  const mcp = detail.protocolConfiguration?.serverProtocol === "MCP";
  const mcpValues = [
    modeled.mcpSessionId,
    modeled.mcpProtocolVersion,
    modeled.mcpMethod,
    modeled.mcpName,
  ];
  if (!mcp && mcpValues.some((value) => value !== undefined)) {
    throw new InputValidationError("MCP options are only valid for MCP Runtimes");
  }
  validateAllowedHeaders(detail, applicationHeaders);

  return {
    runtimeId,
    accountId,
    qualifier: qualifier ?? "DEFAULT",
    payload,
    contentType: contentType || "application/json",
    ...modeled,
    runtimeUserId: modeled.runtimeUserId ?? DEFAULT_RUNTIME_USER_ID,
    accept: modeled.accept ?? (mcp ? "application/json, text/event-stream" : "text/event-stream"),
    ...(applicationHeaders.length > 0 && { applicationHeaders }),
  };
}
