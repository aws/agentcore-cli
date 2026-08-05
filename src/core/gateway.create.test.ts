import { describe, expect, test } from "bun:test";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { CreateRoleCommand, GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import { createSilentLogger } from "../testing";
import { GatewayExecutionRole } from "./gatewayExecutionRole";
import { CoreClient } from "./index";

type SentCommand = { input: unknown; constructor: { name: string } };

function createCore(
  send: (command: SentCommand) => Promise<unknown>,
  sendIam: (command: SentCommand) => Promise<unknown> = async (command) => {
    throw new Error(`unexpected ${command.constructor.name}`);
  },
): CoreClient {
  return new CoreClient({
    createControlClient: () => ({ send }) as unknown as BedrockAgentCoreControlClient,
    createDataClient: () => ({}) as BedrockAgentCoreClient,
    createIamClient: () => ({ send: sendIam }) as unknown as IAMClient,
    logger: createSilentLogger(),
  });
}

function noSuchEntity(): Error {
  const error = new Error("not found");
  error.name = "NoSuchEntityException";
  return error;
}

describe("Gateway create Core operations", () => {
  test("maps unrestricted and MCP Gateways directly when a role is supplied", async () => {
    const sent: SentCommand[] = [];
    const core = createCore(async (command) => {
      sent.push(command);
      return {};
    });
    const roleArn = "arn:aws:iam::123456789012:role/gateway";

    await core.gateway.createGateway(
      { name: "unrestricted", roleArn, authorizerType: "AWS_IAM" },
      { region: "us-west-2" },
    );
    await core.gateway.createGateway(
      { name: "mcp-only", roleArn, protocol: "mcp", authorizerType: "AWS_IAM" },
      { region: "us-west-2" },
    );

    expect(sent.map(({ input }) => input)).toEqual([
      {
        name: "unrestricted",
        roleArn,
        authorizerType: "AWS_IAM",
      },
      {
        name: "mcp-only",
        roleArn,
        protocolType: "MCP",
        authorizerType: "AWS_IAM",
      },
    ]);
    expect(sent.every((command) => command instanceof CreateGatewayCommand)).toBe(true);
  });

  test("creates a Gateway with the default role when none is supplied", async () => {
    const operations: SentCommand[] = [];
    const roleName = GatewayExecutionRole.roleName("orders", "us-west-2");
    const roleArn = `arn:aws:iam::123456789012:role/${roleName}`;
    const core = createCore(
      async (command) => {
        operations.push(command);
        return { gatewayId: "orders-abc" };
      },
      async (command) => {
        operations.push(command);
        if (command instanceof GetRoleCommand) throw noSuchEntity();
        if (command instanceof CreateRoleCommand) return { Role: { Arn: roleArn } };
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    );

    await core.gateway.createGateway(
      { name: "orders", authorizerType: "AWS_IAM" },
      { region: "us-west-2" },
    );

    expect(operations.map((command) => command.constructor.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "CreateGatewayCommand",
    ]);
    expect(operations[2]!.input).toEqual({
      name: "orders",
      roleArn,
      authorizerType: "AWS_IAM",
    });
  });

  test("maps Target and Rule creation directly to the service", async () => {
    const sent: SentCommand[] = [];
    const core = createCore(async (command) => {
      sent.push(command);
      return {};
    });
    const targetConfiguration = {
      http: {
        agentcoreRuntime: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders",
        },
      },
    } as const;
    const actions = [{ routeToTarget: { staticRoute: { targetName: "orders" } } }];

    await core.gateway.createGatewayTarget(
      { gatewayIdentifier: "gateway-1", targetConfiguration },
      { region: "us-west-2" },
    );
    await core.gateway.createGatewayRule(
      { gatewayIdentifier: "gateway-1", priority: 10, actions },
      { region: "us-west-2" },
    );

    expect(sent[0]).toBeInstanceOf(CreateGatewayTargetCommand);
    expect(sent[0]!.input).toEqual({
      gatewayIdentifier: "gateway-1",
      targetConfiguration,
    });
    expect(sent[1]).toBeInstanceOf(CreateGatewayRuleCommand);
    expect(sent[1]!.input).toEqual({
      gatewayIdentifier: "gateway-1",
      priority: 10,
      actions,
    });
  });
});
