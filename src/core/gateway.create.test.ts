import { describe, expect, test } from "bun:test";
import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  GetGatewayTargetCommand,
  GetGatewayCommand,
  GetOauth2CredentialProviderCommand,
  ListGatewayTargetsCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  CreateRoleCommand,
  GetRoleCommand,
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

describe("Gateway create Core command mapping", () => {
  test("maps MCP and HTTP protocols to their SDK representations", async () => {
    const sent: SentCommand[] = [];
    const core = createCore(async (command) => {
      sent.push(command);
      return {};
    });

    await core.gateway.createGateway(
      {
        name: "mcp-gateway",
        roleArn: "arn:aws:iam::123456789012:role/gateway",
        protocol: "mcp",
        authorizerType: "AWS_IAM",
      },
      { region: "us-west-2" },
    );
    await core.gateway.createGateway(
      {
        name: "http-gateway",
        roleArn: "arn:aws:iam::123456789012:role/gateway",
        protocol: "http",
        authorizerType: "AWS_IAM",
      },
      { region: "us-west-2" },
    );

    expect(sent[0]).toBeInstanceOf(CreateGatewayCommand);
    expect(sent[0]!.input).toEqual({
      name: "mcp-gateway",
      roleArn: "arn:aws:iam::123456789012:role/gateway",
      protocolType: "MCP",
      authorizerType: "AWS_IAM",
    });
    expect(sent[1]).toBeInstanceOf(CreateGatewayCommand);
    expect(sent[1]!.input).toEqual({
      name: "http-gateway",
      roleArn: "arn:aws:iam::123456789012:role/gateway",
      authorizerType: "AWS_IAM",
    });
  });

  test("provisions and tightens a default role around Gateway creation", async () => {
    const operations: SentCommand[] = [];
    const policyNames: string[] = [];
    const roleName = gatewayExecutionRoleName("orders", "us-west-2");
    const roleArn = `arn:aws:iam::123456789012:role/${roleName}`;
    const gatewayArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
    const core = createCore(
      async (command) => {
        operations.push(command);
        return { gatewayId: "orders-abc123", gatewayArn };
      },
      async (command) => {
        operations.push(command);
        if (command instanceof GetRoleCommand) throw noSuchEntity();
        if (command instanceof CreateRoleCommand) {
          return {
            Role: {
              Path: "/",
              RoleName: roleName,
              RoleId: "AROATEST",
              Arn: roleArn,
              CreateDate: new Date("2026-08-03T00:00:00Z"),
              Tags: [GATEWAY_ROLE_MANAGED_BY_TAG, GATEWAY_ROLE_RESOURCE_TYPE_TAG],
            },
          };
        }
        if (command instanceof PutRolePolicyCommand) {
          policyNames.push((command.input as { PolicyName: string }).PolicyName);
          return {};
        }
        return {};
      },
    );

    await core.gateway.createGateway(
      {
        name: "orders",
        protocol: "http",
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
      "PutRolePolicyCommand",
      "CreateGatewayCommand",
      "PutRolePolicyCommand",
      "UpdateAssumeRolePolicyCommand",
    ]);
    expect(operations[4]).toBeInstanceOf(CreateGatewayCommand);
    expect(operations[4]!.input).toEqual({
      name: "orders",
      roleArn,
      authorizerType: "AWS_IAM",
      policyEngineConfiguration: {
        arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
        mode: "ENFORCE",
      },
    });
    expect(policyNames).toEqual([GATEWAY_EXECUTION_POLICY_NAME, GATEWAY_EXECUTION_POLICY_NAME]);
  });

  test("maps Target and Rule create inputs directly", async () => {
    const sent: SentCommand[] = [];
    const core = createCore(async (command) => {
      sent.push(command);
      if (command instanceof GetGatewayCommand) {
        return {
          gatewayId: "gateway-1",
          name: "gateway",
          roleArn: "arn:aws:iam::123456789012:role/customer-managed",
        };
      }
      return {};
    });
    const targetConfiguration = {
      http: {
        agentcoreRuntime: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/runtime-1",
        },
      },
    } as const;
    const actions = [{ routeToTarget: { staticRoute: { targetName: "runtime-target" } } }];

    await core.gateway.createGatewayTarget(
      {
        gatewayIdentifier: "gateway-1",
        targetConfiguration,
      },
      { region: "us-west-2" },
    );
    await core.gateway.createGatewayRule(
      {
        gatewayIdentifier: "gateway-1",
        priority: 10,
        actions,
      },
      { region: "us-west-2" },
    );

    expect(sent[0]).toBeInstanceOf(GetGatewayCommand);
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

  test("prepares the union of every paginated Target and deduplicates provider lookups", async () => {
    const operations: SentCommand[] = [];
    const roleName = gatewayExecutionRoleName("orders", "us-west-2");
    const roleArn = `arn:aws:iam::123456789012:role/${roleName}`;
    const oauthProviderArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
      "token-vault/default/oauth2credentialprovider/shared";
    const workloadIdentityArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
      "workload-identity-directory/default/workload-identity/orders-identity";
    let storedPolicy: string | undefined;
    const core = createCore(
      async (command) => {
        operations.push(command);
        if (command instanceof GetGatewayCommand) {
          return {
            gatewayId: "gateway-1",
            gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
            name: "orders",
            roleArn,
            workloadIdentityDetails: { workloadIdentityArn },
          };
        }
        if (command instanceof ListGatewayTargetsCommand) {
          return command.input.nextToken
            ? { items: [{ targetId: "oauth-target" }] }
            : { items: [{ targetId: "lambda-target" }], nextToken: "page-2" };
        }
        if (command instanceof GetGatewayTargetCommand) {
          if (command.input.targetId === "lambda-target") {
            return {
              targetConfiguration: {
                mcp: {
                  lambda: {
                    lambdaArn: "arn:aws:lambda:us-west-2:123456789012:function:existing",
                    toolSchema: { inlinePayload: [] },
                  },
                },
              },
            };
          }
          return {
            targetConfiguration: {
              mcp: { mcpServer: { endpoint: "https://existing.example.test/mcp" } },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "OAUTH",
                credentialProvider: {
                  oauthCredentialProvider: {
                    providerArn: oauthProviderArn,
                    scopes: ["read"],
                  },
                },
              },
            ],
          };
        }
        if (command instanceof GetOauth2CredentialProviderCommand) {
          return {
            clientSecretArn: {
              secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:shared",
            },
          };
        }
        if (command instanceof CreateGatewayTargetCommand) {
          return { targetId: "new-target", status: "CREATING" };
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
      async (command) => {
        operations.push(command);
        if (command instanceof GetRoleCommand) {
          return {
            Role: {
              Path: "/",
              RoleName: roleName,
              RoleId: "AROATEST",
              Arn: roleArn,
              CreateDate: new Date("2026-08-03T00:00:00Z"),
              Tags: [GATEWAY_ROLE_MANAGED_BY_TAG, GATEWAY_ROLE_RESOURCE_TYPE_TAG],
            },
          };
        }
        if (command instanceof PutRolePolicyCommand) {
          storedPolicy = (command.input as { PolicyDocument: string }).PolicyDocument;
          expect((command.input as { PolicyName: string }).PolicyName).toBe(
            GATEWAY_EXECUTION_POLICY_NAME,
          );
          return {};
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      },
    );

    await core.gateway.createGatewayTarget(
      {
        gatewayIdentifier: "gateway-1",
        name: "new-target",
        targetConfiguration: {
          mcp: { mcpServer: { endpoint: "https://new.example.test/mcp" } },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "OAUTH",
            credentialProvider: {
              oauthCredentialProvider: {
                providerArn: oauthProviderArn,
                scopes: ["write"],
              },
            },
          },
        ],
      },
      { region: "us-west-2" },
    );

    const names = operations.map((command) => command.constructor.name);
    expect(names).toEqual([
      "GetGatewayCommand",
      "GetRoleCommand",
      "ListGatewayTargetsCommand",
      "GetGatewayTargetCommand",
      "ListGatewayTargetsCommand",
      "GetGatewayTargetCommand",
      "GetOauth2CredentialProviderCommand",
      "PutRolePolicyCommand",
      "CreateGatewayTargetCommand",
    ]);
    expect(
      operations.filter((command) => command instanceof GetOauth2CredentialProviderCommand),
    ).toHaveLength(1);
    expect(names.indexOf("PutRolePolicyCommand")).toBeLessThan(
      names.indexOf("CreateGatewayTargetCommand"),
    );
    const statements = JSON.parse(storedPolicy!).Statement as {
      Sid: string;
      Resource: string | string[];
    }[];
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetLambda")?.Resource).toEqual([
      "arn:aws:lambda:us-west-2:123456789012:function:existing",
      "arn:aws:lambda:us-west-2:123456789012:function:existing:*",
    ]);
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetCredentialSecrets")?.Resource,
    ).toEqual(["arn:aws:secretsmanager:us-west-2:123456789012:secret:shared"]);
  });
});
