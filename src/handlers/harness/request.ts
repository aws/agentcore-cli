import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, SourceResolutionError } from "../../errors";
import { SourceResolver } from "../../io";

export const isHarnessArn = (value: string | undefined): value is string =>
  value?.match(/^arn:[^:]+:bedrock-agentcore:[^:]+:\d{12}:harness\/.+$/) != null;

export function resolveHarnessArn(
  detail: GetHarnessResponse,
  bearerToken: string | undefined,
): string {
  const harness = detail.harness;
  const harnessArn = harness?.arn;
  if (!isHarnessArn(harnessArn)) {
    throw new InputValidationError("Harness returned an invalid ARN");
  }
  const authorizer = harness?.authorizerConfiguration;
  const customJwt = authorizer !== undefined && "customJWTAuthorizer" in authorizer;
  if (authorizer && !customJwt) {
    throw new InputValidationError("Harness uses an unsupported authorizer");
  }
  if (customJwt && !bearerToken) {
    throw new InputValidationError("CUSTOM_JWT Harness requires --bearer-token");
  }
  if (!customJwt && bearerToken !== undefined) {
    throw new InputValidationError("IAM Harness does not accept --bearer-token");
  }
  return harnessArn;
}

export async function resolveHarnessBearerToken(
  source: string | undefined,
  stdin: NodeJS.ReadStream,
): Promise<string | undefined> {
  try {
    const value = await new SourceResolver({ stdin }).resolveText("bearer-token", source);
    if (value === undefined) return undefined;
    const normalized = value.replace(/\r?\n$/, "");
    if (normalized.length === 0) {
      throw new InputValidationError("--bearer-token must not be empty");
    }
    if (/[\r\n]/.test(normalized)) {
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
