import { describe, expect, mock, test } from "bun:test";
import {
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
  TargetType,
  UpdateGatewayCommand,
  UpdateGatewayTargetCommand,
  type BedrockAgentCoreControlClient,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ERROR_SOURCE, ResultTruncationError } from "../errors";
import type { GatewayTargetUpdatePatch, GatewayUpdatePatch } from "../handlers/gateway/types";
import type { AwsClients } from "./types";
import { GatewayClient } from "./gateway";

const options = { region: "us-west-2", endpointUrl: "https://agentcore.example.test" };

function connector(targetId: string): TargetSummary {
  return { targetId, targetType: TargetType.CONNECTOR } as TargetSummary;
}

function ordinary(targetId: string): TargetSummary {
  return { targetId, targetType: TargetType.MCP_SERVER } as TargetSummary;
}

function gatewayClient(
  send: (command: GetGatewayTargetCommand | ListGatewayTargetsCommand) => Promise<unknown>,
): GatewayClient {
  return new GatewayClient({
    control: () => ({ send: mock(send) }) as never,
  } as unknown as AwsClients);
}

describe("GatewayClient Connector facade", () => {
  test("filters Connector Targets from the final service page", async () => {
    const connectorTarget = connector("connector-1");
    const client = gatewayClient(async (command) => {
      expect(command).toBeInstanceOf(ListGatewayTargetsCommand);
      expect(command.input).toEqual({
        gatewayIdentifier: "gateway-1",
        nextToken: "page-2",
        maxResults: 10,
      });
      return { items: [connectorTarget, ordinary("target-1")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", "page-2", 10, options)).resolves.toEqual(
      {
        items: [connectorTarget],
      },
    );
  });

  test("fills a Connector page and returns a token known to lead to another Connector", async () => {
    const requests: unknown[] = [];
    const connectors = [
      connector("connector-1"),
      connector("connector-2"),
      connector("connector-3"),
    ];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      switch (command.input.nextToken) {
        case undefined:
          return {
            items: [ordinary("target-1"), connectors[0], ordinary("target-2")],
            nextToken: "page-2",
          };
        case "page-2":
          return {
            items: [ordinary("target-3"), connectors[1]],
            nextToken: "page-3",
          };
        case "page-3":
          return { items: [connectors[2]], nextToken: "page-4" };
        case "page-4":
          return { items: [ordinary("target-4"), connector("connector-4")], nextToken: "page-5" };
        default:
          throw new Error(`unexpected token ${command.input.nextToken}`);
      }
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 3, options)).resolves.toEqual(
      {
        items: connectors,
        nextToken: "page-4",
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 3 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 2 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-3", maxResults: 1 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-4", maxResults: 100 },
    ]);
  });

  test("omits nextToken when lookahead finds no more Connectors", async () => {
    const connectorTarget = connector("connector-1");
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [connectorTarget], nextToken: "page-2" }
        : { items: [ordinary("target-2")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 1, options)).resolves.toEqual(
      {
        items: [connectorTarget],
        nextToken: undefined,
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 1 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 100 },
    ]);
  });

  test("returns a partial Connector page when Targets are exhausted", async () => {
    const connectorTarget = connector("connector-1");
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [ordinary("target-1"), connectorTarget], nextToken: "page-2" }
        : { items: [ordinary("target-2")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 3, options)).resolves.toEqual(
      {
        items: [connectorTarget],
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 3 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 2 },
    ]);
  });

  test("fills the default Connector page when maxResults is omitted", async () => {
    const connectors = [connector("connector-1"), connector("connector-2")];
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [connectors[0], ordinary("target-1")], nextToken: "page-2" }
        : { items: [connectors[1], ordinary("target-2")] };
    });

    await expect(
      client.listGatewayConnectors("gateway-1", undefined, undefined, options),
    ).resolves.toEqual({
      items: connectors,
    });
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 100 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 99 },
    ]);
  });

  test("throws when Connector discovery exceeds the Target page cap", async () => {
    let calls = 0;
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      calls += 1;
      return { items: [], nextToken: `page-${calls}` };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 1, options)).rejects.toThrow(
      ResultTruncationError,
    );
    expect(calls).toBe(101);
  });

  test("gets a Connector-backed Target", async () => {
    const connector = {
      targetId: "connector-1",
      targetConfiguration: {
        mcp: { connector: { source: { connectorId: "web-search" } } },
      },
    } as GetGatewayTargetResponse;
    const client = gatewayClient(async (command) => {
      expect(command).toBeInstanceOf(GetGatewayTargetCommand);
      expect(command.input).toEqual({
        gatewayIdentifier: "gateway-1",
        targetId: "connector-1",
      });
      return connector;
    });

    await expect(client.getGatewayConnector("gateway-1", "connector-1", options)).resolves.toEqual(
      connector,
    );
  });

  test("rejects a Target that is not Connector-backed", async () => {
    const client = gatewayClient(async () => ({
      targetId: "target-1",
      targetConfiguration: {
        mcp: { mcpServer: { endpoint: "https://example.test/mcp" } },
      },
    }));

    await expect(client.getGatewayConnector("gateway-1", "target-1", options)).rejects.toThrow(
      'Gateway Target "target-1" is not connector-backed',
    );
  });
});

const OPTIONS = { region: "us-west-2" };

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

test("maps Gateway, Target, and Rule selectors to their delete commands", async () => {
  const { client, commands } = recordingGatewayClient([{}, {}, {}]);

  await client.deleteGateway("gateway-1", OPTIONS);
  await client.deleteGatewayTarget("gateway-1", "target-1", OPTIONS);
  await client.deleteGatewayRule("gateway-1", "rule-1", OPTIONS);

  expect(commands).toHaveLength(3);
  expect(commands[0]).toBeInstanceOf(DeleteGatewayCommand);
  expect((commands[0] as DeleteGatewayCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
  });
  expect(commands[1]).toBeInstanceOf(DeleteGatewayTargetCommand);
  expect((commands[1] as DeleteGatewayTargetCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    targetId: "target-1",
  });
  expect(commands[2]).toBeInstanceOf(DeleteGatewayRuleCommand);
  expect((commands[2] as DeleteGatewayRuleCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    ruleId: "rule-1",
  });
});

function recordingGatewayClient(responses: unknown[]): {
  client: GatewayClient;
  commands: unknown[];
} {
  const commands: unknown[] = [];
  const control = {
    send: async (command: unknown) => {
      commands.push(command);
      return responses.shift();
    },
  } as unknown as BedrockAgentCoreControlClient;
  const clients: AwsClients = {
    control: () => control,
    data: () => {
      throw new Error("unexpected data client");
    },
    iam: () => {
      throw new Error("unexpected IAM client");
    },
    logs: () => {
      throw new Error("unexpected Logs client");
    },
  };
  return { client: new GatewayClient(clients), commands };
}

async function gatewayUpdateInput(
  patch: GatewayUpdatePatch,
  current: GetGatewayResponse = gateway(),
): Promise<UpdateGatewayCommand["input"]> {
  const { client, commands } = recordingGatewayClient([current, {}]);
  await client.updateGateway(patch, OPTIONS);
  expect(commands[0]).toBeInstanceOf(GetGatewayCommand);
  expect((commands[0] as GetGatewayCommand).input).toEqual({
    gatewayIdentifier: patch.id,
  });
  return (commands[1] as UpdateGatewayCommand).input;
}

async function targetUpdateInput(
  patch: GatewayTargetUpdatePatch,
  current: GetGatewayTargetResponse = target(),
): Promise<UpdateGatewayTargetCommand["input"]> {
  const { client, commands } = recordingGatewayClient([current, {}]);
  await client.updateGatewayTarget(patch, OPTIONS);
  expect(commands[0]).toBeInstanceOf(GetGatewayTargetCommand);
  expect((commands[0] as GetGatewayTargetCommand).input).toEqual({
    gatewayIdentifier: patch.gatewayId,
    targetId: patch.targetId,
  });
  return (commands[1] as UpdateGatewayTargetCommand).input;
}

describe("GatewayClient updateGateway", () => {
  test("clears requested fields and merges a Policy Engine mode change", async () => {
    expect(
      await gatewayUpdateInput({
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

  test("rejects CUSTOM_JWT configuration on another authorizer type", async () => {
    const { client } = recordingGatewayClient([
      { ...gateway(), authorizerType: "NONE", authorizerConfiguration: undefined },
    ]);
    await expect(
      client.updateGateway(
        {
          id: "gateway-1",
          authorizerConfiguration: {
            customJWTAuthorizer: {
              discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
            },
          },
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/CUSTOM_JWT/);
  });

  test("classifies missing required service fields as service errors", async () => {
    const { client } = recordingGatewayClient([{ ...gateway(), name: undefined }]);

    await expect(
      client.updateGateway({ id: "gateway-1", description: "after" }, OPTIONS),
    ).rejects.toMatchObject({ source: ERROR_SOURCE.SERVICE });
  });
});

describe("GatewayClient updateGatewayTarget", () => {
  test("updates an MCP endpoint while preserving its schema and ancillary fields", async () => {
    expect(
      await targetUpdateInput({
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

  test("clears optional fields while preserving the Target configuration", async () => {
    expect(
      await targetUpdateInput({
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

  test("rejects endpoint shorthand for a non-MCP-server Target", async () => {
    const { client } = recordingGatewayClient([
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
    ]);
    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: "gateway-1",
          targetId: "target-1",
          endpoint: "https://new.example.test/mcp",
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/existing MCP server Target/);
  });
});

describe("GatewayClient updateGatewayConnector", () => {
  test("updates an existing inference connector Target", async () => {
    const targetConfiguration = {
      inference: { connector: { source: { connectorId: "bedrock-mantle" } } },
    };
    const { client, commands } = recordingGatewayClient([
      { targetId: "target-1", targetConfiguration } as GetGatewayTargetResponse,
      {},
    ]);

    await client.updateGatewayConnector(
      {
        gatewayId: "gateway-1",
        targetId: "target-1",
        description: "after",
      },
      OPTIONS,
    );

    expect(commands[1]).toBeInstanceOf(UpdateGatewayTargetCommand);
    expect((commands[1] as UpdateGatewayTargetCommand).input.targetConfiguration).toEqual(
      targetConfiguration,
    );
  });

  test("rejects an existing non-connector Target", async () => {
    const { client, commands } = recordingGatewayClient([target()]);

    await expect(
      client.updateGatewayConnector(
        {
          gatewayId: "gateway-1",
          targetId: "target-1",
          description: "after",
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/not connector-backed/);
    expect(commands).toHaveLength(1);
  });
});
