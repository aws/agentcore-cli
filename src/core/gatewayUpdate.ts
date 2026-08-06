import type {
  GetGatewayResponse,
  GetGatewayTargetResponse,
  UpdateGatewayRequest,
  UpdateGatewayTargetRequest,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";
import type { GatewayTargetUpdatePatch, GatewayUpdatePatch } from "../handlers/gateway/types";

export class GatewayUpdateRequest {
  static from(current: GetGatewayResponse, patch: GatewayUpdatePatch): UpdateGatewayRequest {
    const name = GatewayUpdateRequest.required(current.name, patch.id, "name");
    const roleArn = GatewayUpdateRequest.required(current.roleArn, patch.id, "role ARN");
    const authorizerType = GatewayUpdateRequest.required(
      current.authorizerType,
      patch.id,
      "authorizer type",
    );
    if (patch.authorizerConfiguration !== undefined && authorizerType !== "CUSTOM_JWT") {
      throw new InputValidationError(
        "--authorizer-configuration is valid only for a CUSTOM_JWT Gateway",
      );
    }

    const description = GatewayUpdateRequest.replace(current.description, patch.description);
    const protocolType = patch.clearProtocol ? undefined : current.protocolType;
    const protocolConfiguration = GatewayUpdateRequest.replace(
      current.protocolConfiguration,
      patch.protocolConfiguration,
    );
    const customTransformConfiguration = GatewayUpdateRequest.replace(
      current.customTransformConfiguration,
      patch.customTransformConfiguration,
    );
    const interceptorConfigurations = GatewayUpdateRequest.replace(
      current.interceptorConfigurations,
      patch.interceptorConfigurations,
    );
    const policyEngineConfiguration = GatewayUpdateRequest.policyEngine(current, patch);
    const exceptionLevel = GatewayUpdateRequest.replace(
      current.exceptionLevel,
      patch.exceptionLevel,
    );
    const wafConfiguration = GatewayUpdateRequest.replace(
      current.wafConfiguration,
      patch.wafConfiguration,
    );

    return {
      gatewayIdentifier: patch.id,
      name,
      roleArn: patch.roleArn ?? roleArn,
      authorizerType,
      ...(description !== undefined ? { description } : {}),
      ...(protocolType !== undefined ? { protocolType } : {}),
      ...(protocolConfiguration !== undefined ? { protocolConfiguration } : {}),
      ...(current.authorizerConfiguration !== undefined ||
      patch.authorizerConfiguration !== undefined
        ? {
            authorizerConfiguration:
              patch.authorizerConfiguration ?? current.authorizerConfiguration,
          }
        : {}),
      ...(current.kmsKeyArn !== undefined ? { kmsKeyArn: current.kmsKeyArn } : {}),
      ...(customTransformConfiguration !== undefined ? { customTransformConfiguration } : {}),
      ...(interceptorConfigurations !== undefined ? { interceptorConfigurations } : {}),
      ...(policyEngineConfiguration !== undefined ? { policyEngineConfiguration } : {}),
      ...(exceptionLevel !== undefined ? { exceptionLevel } : {}),
      ...(wafConfiguration !== undefined ? { wafConfiguration } : {}),
    };
  }

  private static policyEngine(
    current: GetGatewayResponse,
    patch: GatewayUpdatePatch,
  ): GetGatewayResponse["policyEngineConfiguration"] {
    if (patch.policyEngineConfiguration === null) return undefined;
    if (patch.policyEngineConfiguration === undefined) return current.policyEngineConfiguration;

    const arn = patch.policyEngineConfiguration.arn ?? current.policyEngineConfiguration?.arn;
    const mode = patch.policyEngineConfiguration.mode ?? current.policyEngineConfiguration?.mode;
    if (!arn || !mode) {
      throw new InputValidationError(
        "Policy Engine update requires an ARN and mode, either existing or supplied",
      );
    }
    return { arn, mode };
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }

  private static required<T>(value: T | undefined, id: string, field: string): T {
    if (value === undefined) {
      throw new InputValidationError(`Gateway "${id}" is missing its ${field} required for update`);
    }
    return value;
  }
}

export class GatewayTargetUpdateRequest {
  static from(
    current: GetGatewayTargetResponse,
    patch: GatewayTargetUpdatePatch,
  ): UpdateGatewayTargetRequest {
    const targetConfiguration =
      patch.targetConfiguration ??
      (patch.endpoint !== undefined
        ? GatewayTargetUpdateRequest.withEndpoint(current, patch.endpoint)
        : current.targetConfiguration);
    if (!targetConfiguration) {
      throw new InputValidationError(
        `Gateway Target "${patch.targetId}" is missing its configuration required for update`,
      );
    }

    const name = GatewayTargetUpdateRequest.replace(current.name, patch.name);
    const description = GatewayTargetUpdateRequest.replace(current.description, patch.description);
    const credentialProviderConfigurations = GatewayTargetUpdateRequest.replace(
      current.credentialProviderConfigurations,
      patch.credentialProviderConfigurations,
    );
    const metadataConfiguration = GatewayTargetUpdateRequest.replace(
      current.metadataConfiguration,
      patch.metadataConfiguration,
    );
    const privateEndpoint = GatewayTargetUpdateRequest.replace(
      current.privateEndpoint,
      patch.privateEndpoint,
    );

    return {
      gatewayIdentifier: patch.gatewayId,
      targetId: patch.targetId,
      targetConfiguration,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(credentialProviderConfigurations !== undefined
        ? { credentialProviderConfigurations }
        : {}),
      ...(metadataConfiguration !== undefined ? { metadataConfiguration } : {}),
      ...(privateEndpoint !== undefined ? { privateEndpoint } : {}),
    };
  }

  private static withEndpoint(
    current: GetGatewayTargetResponse,
    endpoint: string,
  ): NonNullable<GetGatewayTargetResponse["targetConfiguration"]> {
    const mcpServer = current.targetConfiguration?.mcp?.mcpServer;
    if (!mcpServer) {
      throw new InputValidationError("--endpoint requires an existing MCP server Target");
    }
    return {
      mcp: {
        mcpServer: {
          ...mcpServer,
          endpoint,
        },
      },
    };
  }

  private static replace<T>(
    current: T | undefined,
    replacement: T | null | undefined,
  ): T | undefined {
    if (replacement === undefined) return current;
    return replacement === null ? undefined : replacement;
  }
}
