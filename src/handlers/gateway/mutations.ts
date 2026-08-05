import type { CreateGatewayRequest } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../errors";
import type {
  CreateGatewayInput,
  CreateGatewayTargetInput,
  ResolvedCreateGatewayInput,
} from "./types";

export function buildGatewayCreateRequest(input: ResolvedCreateGatewayInput): CreateGatewayRequest {
  validateGatewayCreateInput(input);
  const { protocol, ...request } = input;

  return {
    ...request,
    ...(protocol === "mcp" ? { protocolType: "MCP" as const } : {}),
  };
}

export function validateGatewayCreateInput(input: CreateGatewayInput): CreateGatewayInput {
  if (!input.name) {
    throw new InputValidationError("Gateway name is required");
  }
  if (!input.authorizerType) {
    throw new InputValidationError("Gateway authorizer type is required");
  }
  if (input.authorizerType === "CUSTOM_JWT" && !input.authorizerConfiguration) {
    throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
  }
  if (input.authorizerType !== "CUSTOM_JWT" && input.authorizerConfiguration) {
    throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
  }
  const policyEngine = input.policyEngineConfiguration;
  if (policyEngine && (!policyEngine.arn || !policyEngine.mode)) {
    throw new InputValidationError(
      "Policy Engine attachment requires --policy-engine-arn and --policy-engine-mode",
    );
  }

  return input;
}

export function validateGatewayTargetCreateInput(
  input: CreateGatewayTargetInput,
): CreateGatewayTargetInput {
  if (!input.gatewayIdentifier) {
    throw new InputValidationError("Gateway ID is required");
  }
  if (!input.targetConfiguration) {
    throw new InputValidationError("Target configuration is required");
  }
  if (!input.name && input.targetConfiguration.http?.agentcoreRuntime === undefined) {
    throw new InputValidationError("Target name is required for non-Runtime targets");
  }
  return input;
}
