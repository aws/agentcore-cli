import { describe, expect, mock, test } from "bun:test";
import {
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
  TargetType,
  type GetGatewayTargetResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ResultTruncationError } from "../errors";
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
