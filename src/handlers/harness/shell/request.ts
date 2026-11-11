import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../errors";
import type { HarnessShellRequest } from "../types";
import { resolveHarnessArn } from "../request";

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
  const harnessArn = resolveHarnessArn(detail, input.bearerToken);
  return {
    harnessArn,
    qualifier: input.qualifier,
    ...(input.runtimeSessionId !== undefined && { runtimeSessionId: input.runtimeSessionId }),
    ...(input.shellId !== undefined && { shellId: input.shellId }),
    ...(input.bearerToken !== undefined && { bearerToken: input.bearerToken }),
  };
}
