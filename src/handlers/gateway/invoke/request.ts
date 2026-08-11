import { validateHeaderName, validateHeaderValue } from "node:http";
import type { AuthorizerType, GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError, SourceResolutionError } from "../../../errors";
import { SourceResolver } from "../../../io";
import type { GatewayInvokeMethod, GatewayInvokeRequest } from "../types";

export const gatewayIdSchema = z
  .string()
  .refine((value) => !value.startsWith("arn:"), "must be a Gateway ID, not an ARN");

type GatewayInvokeInput = {
  gatewayId: string;
  path?: string;
  method?: GatewayInvokeMethod;
  payload?: Uint8Array;
  contentType?: string;
  accept?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
  runtimeSessionId?: string;
  mcpSessionId?: string;
  mcpProtocolVersion?: string;
};

const RESERVED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
  "x-amzn-bedrock-agentcore-runtime-session-id",
]);

export async function resolveGatewayInvokeSources(
  sources: { payload?: string; bearerToken?: string },
  stdin: NodeJS.ReadStream,
  signal?: AbortSignal,
): Promise<{ payload?: Uint8Array; bearerToken?: string }> {
  if (sources.payload === "-" && sources.bearerToken === "-") {
    throw new InputValidationError("Payload and bearer token cannot both read from stdin");
  }

  const resolver = new SourceResolver({ stdin, signal });
  try {
    const payload = await resolver.resolveBytes("payload", sources.payload);
    const bearerToken = await resolver.resolveText("bearer-token", sources.bearerToken);
    return {
      ...(payload !== undefined && { payload }),
      ...(bearerToken !== undefined && { bearerToken }),
    };
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      throw new InputValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

export async function resolveGatewayInvokeTuiBearerToken(
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

export function parseGatewayInvokeHeaders(values: string[] = []): [string, string][] {
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
    if (RESERVED_HEADERS.has(lower)) {
      throw new InputValidationError(`Application header is reserved: ${name}`);
    }
    return [name, value];
  });
}

function resolveGatewayInvokeUrl(gatewayUrl: string | undefined, path?: string): string {
  if (!gatewayUrl) throw new InputValidationError("Gateway returned no invocation URL");

  let base: URL;
  try {
    base = new URL(gatewayUrl);
  } catch (error) {
    throw new InputValidationError("Gateway returned an invalid invocation URL", { cause: error });
  }
  if (base.protocol !== "https:") {
    throw new InputValidationError("Gateway invocation requires an HTTPS URL");
  }
  if (base.username || base.password || base.hash) {
    throw new InputValidationError("Gateway returned an invalid invocation URL");
  }
  if (path === undefined) return base.href;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) || path.startsWith("//")) {
    throw new InputValidationError("--path must be relative to the Gateway");
  }

  const relative = path.replace(/^\/+/, "");
  const pathOnly = relative.split(/[?#]/, 1)[0]!;
  if (pathOnly.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new InputValidationError("--path cannot contain '.' or '..' segments");
  }

  const url = new URL(relative, `${base.origin}/`);
  if (url.origin !== base.origin || url.username || url.password || url.hash) {
    throw new InputValidationError("--path must stay within the selected Gateway");
  }
  return url.href;
}

function validateAuthorizer(
  authorizerType: AuthorizerType | undefined,
  bearerToken?: string,
): AuthorizerType {
  switch (authorizerType) {
    case "CUSTOM_JWT":
      if (!bearerToken) {
        throw new InputValidationError(`${authorizerType} Gateway requires --bearer-token`);
      }
      return authorizerType;
    case "AUTHENTICATE_ONLY":
    case "AWS_IAM":
    case "NONE":
      if (bearerToken !== undefined) {
        throw new InputValidationError(`${authorizerType} Gateway does not accept --bearer-token`);
      }
      return authorizerType;
    default:
      throw new InputValidationError("Gateway uses an unsupported authorizer");
  }
}

export function normalizeGatewayInvokeRequest(
  detail: GetGatewayResponse,
  input: GatewayInvokeInput,
): GatewayInvokeRequest {
  const method = input.method ?? "POST";
  if (method === "POST" && input.payload === undefined) {
    throw new InputValidationError("required option '--payload <payload>' not specified");
  }
  if (method === "GET" && input.payload !== undefined) {
    throw new InputValidationError("GET requests do not accept --payload");
  }

  const authorizerType = validateAuthorizer(detail.authorizerType, input.bearerToken);
  const {
    gatewayId,
    path,
    payload,
    contentType,
    applicationHeaders = [],
    accept,
    bearerToken,
    runtimeSessionId,
    mcpSessionId,
    mcpProtocolVersion,
  } = input;

  return {
    gatewayId,
    url: resolveGatewayInvokeUrl(detail.gatewayUrl, path),
    method,
    authorizerType,
    ...(payload !== undefined && { payload }),
    ...(contentType !== undefined
      ? { contentType }
      : payload !== undefined
        ? { contentType: "application/json" }
        : {}),
    ...(applicationHeaders.length > 0 && { applicationHeaders }),
    ...(accept !== undefined && { accept }),
    ...(bearerToken !== undefined && { bearerToken }),
    ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    ...(mcpSessionId !== undefined && { mcpSessionId }),
    ...(mcpProtocolVersion !== undefined && { mcpProtocolVersion }),
  };
}
