import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import type { HarnessShellRequest } from "../types";

export function normalizeHarnessShellRequest(
  detail: GetHarnessResponse,
  input: Omit<HarnessShellRequest, "harnessArn">,
): HarnessShellRequest {
  const harness = detail.harness;
  if (harness?.status !== "READY") {
    throw new InputValidationError(
      `Harness is not ready (status: ${harness?.status ?? "unknown"})`,
    );
  }
  const harnessArn = harness.arn;
  if (!harnessArn?.match(/^arn:[^:]+:bedrock-agentcore:[^:]+:\d{12}:harness\/.+$/)) {
    throw new InputValidationError("Harness returned an invalid ARN");
  }
  const authorizer = harness.authorizerConfiguration;
  const customJwt = authorizer !== undefined && "customJWTAuthorizer" in authorizer;
  if (authorizer && !customJwt) {
    throw new InputValidationError("Harness uses an unsupported authorizer");
  }
  if (customJwt && !input.bearerToken) {
    throw new InputValidationError("CUSTOM_JWT Harness requires --bearer-token");
  }
  if (!customJwt && input.bearerToken !== undefined) {
    throw new InputValidationError("IAM Harness does not accept --bearer-token");
  }
  return {
    harnessArn,
    qualifier: input.qualifier,
    ...(input.runtimeSessionId !== undefined && { runtimeSessionId: input.runtimeSessionId }),
    ...(input.shellId !== undefined && { shellId: input.shellId }),
    ...(input.bearerToken !== undefined && { bearerToken: input.bearerToken }),
  };
}
