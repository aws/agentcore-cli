import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, SourceResolutionError } from "../../../errors";
import { SourceResolver } from "../../../io";
import type { RuntimeShellRequest } from "../types";

export type RuntimeShellInput = Omit<RuntimeShellRequest, "runtimeArn">;

export async function resolveRuntimeShellBearerToken(
  source: string | undefined,
  stdin: NodeJS.ReadStream,
): Promise<string | undefined> {
  if (source === "-") {
    throw new InputValidationError(
      "stdin bearer tokens are not available when opening an interactive shell",
    );
  }
  try {
    const value = await new SourceResolver({ stdin }).resolveText("bearer-token", source);
    if (value === undefined) return undefined;
    const normalized = value.replace(/\r?\n$/, "");
    if (normalized.includes("\n")) {
      throw new InputValidationError("--bearer-token must be a single-line value");
    }
    return normalized;
  } catch (error) {
    if (error instanceof SourceResolutionError) {
      throw new InputValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

export function normalizeRuntimeShellRequest(
  detail: GetAgentRuntimeResponse,
  input: RuntimeShellInput,
): RuntimeShellRequest {
  if (detail.status !== "READY") {
    throw new InputValidationError(`Runtime is not ready (status: ${detail.status ?? "unknown"})`);
  }
  const runtimeArn = detail.agentRuntimeArn;
  if (!runtimeArn?.match(/^arn:[^:]+:bedrock-agentcore:[^:]+:\d{12}:runtime\/.+$/)) {
    throw new InputValidationError("Runtime returned an invalid ARN");
  }

  const authorizer = detail.authorizerConfiguration;
  const customJwt = authorizer !== undefined && "customJWTAuthorizer" in authorizer;
  if (authorizer && !customJwt) {
    throw new InputValidationError("Runtime uses an unsupported authorizer");
  }
  if (customJwt && !input.bearerToken) {
    throw new InputValidationError("CUSTOM_JWT Runtime requires --bearer-token");
  }
  if (!customJwt && input.bearerToken !== undefined) {
    throw new InputValidationError("IAM Runtime does not accept --bearer-token");
  }
  return {
    runtimeArn,
    qualifier: input.qualifier,
    ...(input.runtimeSessionId !== undefined && {
      runtimeSessionId: input.runtimeSessionId,
    }),
    ...(input.bearerToken !== undefined && { bearerToken: input.bearerToken }),
  };
}
