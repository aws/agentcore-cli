import type {
  CreateGatewayRequest,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
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
  const { protocol, ...request } = input;

  if (!request.name) {
    throw new InputValidationError("Gateway name is required");
  }
  if (!request.authorizerType) {
    throw new InputValidationError("Gateway authorizer type is required");
  }
  if (request.authorizerType === "CUSTOM_JWT" && !request.authorizerConfiguration) {
    throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
  }
  if (request.authorizerType !== "CUSTOM_JWT" && request.authorizerConfiguration) {
    throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
  }
  if (protocol === "http" && request.protocolConfiguration) {
    throw new InputValidationError("--protocol-configuration is valid only with --protocol mcp");
  }
  const policyEngine = request.policyEngineConfiguration;
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
  const variant = targetVariant(input.targetConfiguration);
  if (!variant) {
    throw new InputValidationError("Target configuration must use a known Target variant");
  }
  if (!input.name && variant !== "http.agentcoreRuntime") {
    throw new InputValidationError("Target name is required for non-Runtime targets");
  }
  if (
    input.credentialProviderConfigurations &&
    input.credentialProviderConfigurations.length === 0
  ) {
    throw new InputValidationError("Credential provider configurations cannot be empty");
  }
  return input;
}

export function targetVariant(configuration: TargetConfiguration): string | undefined {
  if ("mcp" in configuration && configuration.mcp) {
    return memberVariant("mcp", configuration.mcp, [
      "openApiSchema",
      "smithyModel",
      "lambda",
      "mcpServer",
      "apiGateway",
      "connector",
    ]);
  }
  if ("http" in configuration && configuration.http) {
    return memberVariant("http", configuration.http, ["agentcoreRuntime", "passthrough"]);
  }
  if ("inference" in configuration && configuration.inference) {
    return memberVariant("inference", configuration.inference, ["connector", "provider"]);
  }
  return undefined;
}

function memberVariant(
  outer: string,
  value: object,
  members: readonly string[],
): string | undefined {
  const member = members.find((candidate) => candidate in value);
  return member ? `${outer}.${member}` : undefined;
}
