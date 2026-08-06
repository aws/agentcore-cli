import { describe, expect, test } from "bun:test";
import type {
  GetGatewayResponse,
  GetGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { GatewayTargetUpdateRequest, GatewayUpdateRequest } from "./gatewayUpdate";

function gateway(): GetGatewayResponse {
  return {
    gatewayId: "gateway-1",
    name: "orders",
    roleArn: "arn:aws:iam::123456789012:role/orders",
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJWTAuthorizer: {
        discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
      },
    },
    protocolType: "MCP",
    protocolConfiguration: { mcp: { supportedVersions: ["2025-11-25"] } },
    description: "before",
    kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key-1",
    policyEngineConfiguration: {
      arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-1",
      mode: "LOG_ONLY",
    },
    exceptionLevel: "DEBUG",
  } as GetGatewayResponse;
}

function target(): GetGatewayTargetResponse {
  return {
    targetId: "target-1",
    name: "calendar",
    description: "before",
    targetConfiguration: {
      mcp: {
        mcpServer: {
          endpoint: "https://old.example.test/mcp",
          mcpToolSchema: { s3: { uri: "s3://schemas/calendar.json" } },
          listingMode: "DEFAULT",
          resourcePriority: 100,
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
    metadataConfiguration: { allowedRequestHeaders: ["x-request-id"] },
  } as unknown as GetGatewayTargetResponse;
}

describe("GatewayUpdateRequest", () => {
  test("preserves required and omitted fields while replacing selected configuration", () => {
    expect(
      GatewayUpdateRequest.from(gateway(), {
        id: "gateway-1",
        description: "after",
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      name: "orders",
      roleArn: "arn:aws:iam::123456789012:role/orders",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
        },
      },
      protocolType: "MCP",
      protocolConfiguration: { mcp: { supportedVersions: ["2025-11-25"] } },
      description: "after",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key-1",
      policyEngineConfiguration: {
        arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-1",
        mode: "LOG_ONLY",
      },
      exceptionLevel: "DEBUG",
    });
  });

  test("clears requested fields and merges a Policy Engine mode change", () => {
    expect(
      GatewayUpdateRequest.from(gateway(), {
        id: "gateway-1",
        clearProtocol: true,
        description: null,
        protocolConfiguration: null,
        policyEngineConfiguration: { mode: "ENFORCE" },
        exceptionLevel: null,
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      name: "orders",
      roleArn: "arn:aws:iam::123456789012:role/orders",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
        },
      },
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key-1",
      policyEngineConfiguration: {
        arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-1",
        mode: "ENFORCE",
      },
    });
  });

  test("rejects CUSTOM_JWT configuration on another authorizer type", () => {
    expect(() =>
      GatewayUpdateRequest.from(
        { ...gateway(), authorizerType: "NONE", authorizerConfiguration: undefined },
        {
          id: "gateway-1",
          authorizerConfiguration: {
            customJWTAuthorizer: {
              discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
            },
          },
        },
      ),
    ).toThrow(/CUSTOM_JWT/);
  });
});

describe("GatewayTargetUpdateRequest", () => {
  test("updates an MCP endpoint while preserving its schema and ancillary fields", () => {
    expect(
      GatewayTargetUpdateRequest.from(target(), {
        gatewayId: "gateway-1",
        targetId: "target-1",
        endpoint: "https://new.example.test/mcp",
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      targetId: "target-1",
      name: "calendar",
      description: "before",
      targetConfiguration: {
        mcp: {
          mcpServer: {
            endpoint: "https://new.example.test/mcp",
            mcpToolSchema: { s3: { uri: "s3://schemas/calendar.json" } },
            listingMode: "DEFAULT",
            resourcePriority: 100,
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
      metadataConfiguration: { allowedRequestHeaders: ["x-request-id"] },
    });
  });

  test("clears optional fields while preserving the Target configuration", () => {
    expect(
      GatewayTargetUpdateRequest.from(target(), {
        gatewayId: "gateway-1",
        targetId: "target-1",
        description: null,
        credentialProviderConfigurations: null,
        metadataConfiguration: null,
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      targetId: "target-1",
      name: "calendar",
      targetConfiguration: target().targetConfiguration,
    });
  });

  test("rejects endpoint shorthand for a non-MCP-server Target", () => {
    expect(() =>
      GatewayTargetUpdateRequest.from(
        {
          targetId: "target-1",
          targetConfiguration: {
            http: {
              passthrough: {
                endpoint: "https://example.test",
                protocolType: "CUSTOM",
              },
            },
          },
        } as GetGatewayTargetResponse,
        {
          gatewayId: "gateway-1",
          targetId: "target-1",
          endpoint: "https://new.example.test/mcp",
        },
      ),
    ).toThrow(/existing MCP server Target/);
  });
});
