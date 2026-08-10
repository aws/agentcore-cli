import { describe, expect, mock, test } from "bun:test";
import {
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
  TargetType,
  type GetGatewayTargetResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { AwsClients } from "./types";
import { GatewayClient } from "./gateway";

const options = { region: "us-west-2", endpointUrl: "https://agentcore.example.test" };

function gatewayClient(
  send: (command: GetGatewayTargetCommand | ListGatewayTargetsCommand) => Promise<unknown>,
): GatewayClient {
  return new GatewayClient({
    control: () => ({ send: mock(send) }) as never,
  } as unknown as AwsClients);
}

describe("GatewayClient Connector facade", () => {
  test("lists only Connector Targets and preserves the service token", async () => {
    const connector = {
      targetId: "connector-1",
      targetType: TargetType.CONNECTOR,
    } as TargetSummary;
    const ordinary = {
      targetId: "target-1",
      targetType: TargetType.MCP_SERVER,
    } as TargetSummary;
    const client = gatewayClient(async (command) => {
      expect(command).toBeInstanceOf(ListGatewayTargetsCommand);
      expect(command.input).toEqual({
        gatewayIdentifier: "gateway-1",
        nextToken: "page-2",
        maxResults: 10,
      });
      return { items: [connector, ordinary], nextToken: "page-3" };
    });

    await expect(client.listGatewayConnectors("gateway-1", "page-2", 10, options)).resolves.toEqual(
      {
        items: [connector],
        nextToken: "page-3",
      },
    );
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
