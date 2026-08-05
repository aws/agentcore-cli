import { describe, expect, test } from "bun:test";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  GetGatewayCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  CreateRoleCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { createSilentLogger } from "../testing";
import {
  gatewayExecutionRoleName,
  GATEWAY_EXECUTION_POLICY_NAME,
  GATEWAY_ROLE_MANAGED_BY_TAG,
  GATEWAY_ROLE_RESOURCE_TYPE_TAG,
} from "./gatewayExecutionRole";
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

function managedRole(name: string) {
  return {
    Path: "/",
    RoleName: name,
    RoleId: "AROATEST",
    Arn: `arn:aws:iam::123456789012:role/${name}`,
    CreateDate: new Date("2026-08-05T00:00:00Z"),
    Tags: [GATEWAY_ROLE_MANAGED_BY_TAG, GATEWAY_ROLE_RESOURCE_TYPE_TAG],
  };
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

  test("prepares and finalizes a CLI-managed Gateway role", async () => {
    const operations: SentCommand[] = [];
    const roleName = gatewayExecutionRoleName("orders", "us-west-2");
    const role = managedRole(roleName);
    const gatewayArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc";
    const core = createCore(
      async (command) => {
        operations.push(command);
        return { gatewayId: "orders-abc", gatewayArn };
      },
      async (command) => {
        operations.push(command);
        if (command instanceof GetRoleCommand) throw noSuchEntity();
        if (command instanceof CreateRoleCommand) return { Role: role };
        if (command instanceof GetRolePolicyCommand) throw noSuchEntity();
        return {};
      },
    );

    await core.gateway.createGateway(
      {
        name: "orders",
        authorizerType: "AWS_IAM",
        policyEngineConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
          mode: "ENFORCE",
        },
      },
      { region: "us-west-2" },
    );

    expect(operations.map((command) => command.constructor.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "UpdateAssumeRolePolicyCommand",
      "GetRolePolicyCommand",
      "PutRolePolicyCommand",
      "CreateGatewayCommand",
      "UpdateAssumeRolePolicyCommand",
      "PutRolePolicyCommand",
    ]);
    expect(operations[5]!.input).toMatchObject({ roleArn: role.Arn });
    for (const command of operations.filter(
      (operation) => operation instanceof PutRolePolicyCommand,
    )) {
      expect(command.input).toMatchObject({ PolicyName: GATEWAY_EXECUTION_POLICY_NAME });
    }
  });

  test("adds managed-role Target permissions before create and commits them", async () => {
    const operations: SentCommand[] = [];
    const roleName = gatewayExecutionRoleName("orders", "us-west-2");
    let storedPolicy: string | undefined;
    const core = createCore(
      async (command) => {
        operations.push(command);
        if (command instanceof GetGatewayCommand) {
          return {
            gatewayId: "gateway-1",
            gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
            name: "orders",
            roleArn: managedRole(roleName).Arn,
          };
        }
        if (command instanceof CreateGatewayTargetCommand) {
          return { targetId: "target-1" };
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
      async (command) => {
        operations.push(command);
        if (command instanceof GetRoleCommand) return { Role: managedRole(roleName) };
        if (command instanceof GetRolePolicyCommand) {
          if (!storedPolicy) throw noSuchEntity();
          return { PolicyDocument: storedPolicy };
        }
        if (command instanceof PutRolePolicyCommand) {
          storedPolicy = command.input.PolicyDocument;
          return {};
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    );
    const lambdaArn = "arn:aws:lambda:us-west-2:123456789012:function:calculator";

    await core.gateway.createGatewayTarget(
      {
        gatewayIdentifier: "gateway-1",
        name: "calculator",
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn,
              toolSchema: { inlinePayload: [] },
            },
          },
        },
      },
      { region: "us-west-2" },
    );

    const names = operations.map((command) => command.constructor.name);
    expect(names).toEqual([
      "GetGatewayCommand",
      "GetRoleCommand",
      "GetRolePolicyCommand",
      "PutRolePolicyCommand",
      "CreateGatewayTargetCommand",
      "GetRolePolicyCommand",
    ]);
    expect(names.indexOf("PutRolePolicyCommand")).toBeLessThan(
      names.indexOf("CreateGatewayTargetCommand"),
    );
    expect(JSON.parse(storedPolicy!).Statement).toContainEqual({
      Sid: "AgentCoreGatewayTargetLambda",
      Effect: "Allow",
      Action: "lambda:InvokeFunction",
      Resource: [lambdaArn, `${lambdaArn}:*`],
    });
  });

  test("restores the previous managed-role policy when Target create fails", async () => {
    const roleName = gatewayExecutionRoleName("orders", "us-west-2");
    const previousPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AgentCoreGatewayConfigLambda",
          Effect: "Allow",
          Action: "lambda:InvokeFunction",
          Resource: "arn:aws:lambda:us-west-2:123456789012:function:guard",
        },
      ],
    });
    const writtenPolicies: string[] = [];
    const createError = new Error("target rejected");
    const core = createCore(
      async (command) => {
        if (command instanceof GetGatewayCommand) {
          return {
            gatewayId: "gateway-1",
            gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
            name: "orders",
            roleArn: managedRole(roleName).Arn,
          };
        }
        if (command instanceof CreateGatewayTargetCommand) throw createError;
        throw new Error(`unexpected ${command.constructor.name}`);
      },
      async (command) => {
        if (command instanceof GetRoleCommand) return { Role: managedRole(roleName) };
        if (command instanceof GetRolePolicyCommand) {
          return { PolicyDocument: previousPolicy };
        }
        if (command instanceof PutRolePolicyCommand) {
          writtenPolicies.push(command.input.PolicyDocument!);
          return {};
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    );

    await expect(
      core.gateway.createGatewayTarget(
        {
          gatewayIdentifier: "gateway-1",
          name: "calculator",
          targetConfiguration: {
            mcp: {
              lambda: {
                lambdaArn: "arn:aws:lambda:us-west-2:123456789012:function:calculator",
                toolSchema: { inlinePayload: [] },
              },
            },
          },
        },
        { region: "us-west-2" },
      ),
    ).rejects.toBe(createError);

    expect(writtenPolicies).toHaveLength(2);
    expect(JSON.parse(writtenPolicies[1]!)).toEqual(JSON.parse(previousPolicy));
  });

  test("leaves customer-managed Target roles untouched and maps Rules directly", async () => {
    const sent: SentCommand[] = [];
    const core = createCore(async (command) => {
      sent.push(command);
      if (command instanceof GetGatewayCommand) {
        return {
          gatewayId: "gateway-1",
          name: "orders",
          roleArn: "arn:aws:iam::123456789012:role/customer-managed",
        };
      }
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

    expect(sent[1]).toBeInstanceOf(CreateGatewayTargetCommand);
    expect(sent[1]!.input).toEqual({
      gatewayIdentifier: "gateway-1",
      targetConfiguration,
    });
    expect(sent[2]).toBeInstanceOf(CreateGatewayRuleCommand);
    expect(sent[2]!.input).toEqual({
      gatewayIdentifier: "gateway-1",
      priority: 10,
      actions,
    });
  });
});
