import { describe, expect, test } from "bun:test";
import type { GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { GetRoleCommand, type IAMClient } from "@aws-sdk/client-iam";
import {
  GatewayExecutionRole,
  gatewayExecutionRoleName,
  GATEWAY_ROLE_MANAGED_BY_TAG,
  GATEWAY_ROLE_RESOURCE_TYPE_TAG,
  retryWhileGatewayRoleChangesPropagate,
  type GatewayTargetRoleConfiguration,
} from "./gatewayExecutionRole";
import { GatewayExecutionPolicy } from "./gatewayExecutionRolePolicy";

const REGION = "us-west-2";
const ACCOUNT_ID = "123456789012";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc";
const WORKLOAD_IDENTITY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
  "workload-identity-directory/default/workload-identity/orders-identity";

function policyStatements(policy: GatewayExecutionPolicy) {
  return JSON.parse(policy.toJSON()!).Statement as {
    Sid: string;
    Action: string | string[];
    Resource: string | string[];
  }[];
}

describe("Gateway execution role ownership", () => {
  test("derives deterministic collision-resistant names within IAM limits", () => {
    const name = "a".repeat(100);
    const first = gatewayExecutionRoleName(name, REGION);

    expect(first.length).toBeLessThanOrEqual(64);
    expect(gatewayExecutionRoleName(name, REGION)).toBe(first);
    expect(gatewayExecutionRoleName(name, "us-east-1")).not.toBe(first);
    expect(gatewayExecutionRoleName(`${name}b`, REGION)).not.toBe(first);
  });

  test("refuses to adopt an untagged role with the generated name", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const iam = {
      send: async (command: unknown) => {
        expect(command).toBeInstanceOf(GetRoleCommand);
        return {
          Role: {
            RoleName: roleName,
            Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
            Tags: [],
          },
        };
      },
    } as unknown as IAMClient;

    await expect(GatewayExecutionRole.prepareCreate(iam, "orders", REGION, {})).rejects.toThrow(
      "is not managed by the agentcore CLI",
    );
  });

  test("recognizes CLI ownership only when both Gateway tags are present", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const iam = {
      send: async () => ({
        Role: {
          RoleName: roleName,
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
          Tags: [GATEWAY_ROLE_MANAGED_BY_TAG, GATEWAY_ROLE_RESOURCE_TYPE_TAG],
        },
      }),
    } as unknown as IAMClient;

    const role = await GatewayExecutionRole.fromGateway(
      iam,
      {
        gatewayId: "orders-abc",
        gatewayArn: GATEWAY_ARN,
        name: "orders",
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
      } as GetGatewayResponse,
      REGION,
    );

    expect(role?.roleName).toBe(roleName);
  });
});

describe("Gateway execution policy", () => {
  test("derives Gateway configuration permissions", () => {
    const policy = GatewayExecutionPolicy.forGateway(
      {
        interceptorConfigurations: [
          {
            interceptor: {
              lambda: {
                arn: "arn:aws:lambda:us-west-2:123456789012:function:interceptor",
              },
            },
            interceptionPoints: ["REQUEST"],
          },
        ],
        policyEngineConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders",
          mode: "ENFORCE",
        },
      },
      GATEWAY_ARN,
    );

    expect(policyStatements(policy).map(({ Sid }) => Sid)).toEqual([
      "AgentCoreGatewayConfigGuardrail",
      "AgentCoreGatewayConfigLambda",
      "AgentCoreGatewayConfigPolicyAuthorization",
      "AgentCoreGatewayConfigPolicyEngine",
    ]);
  });

  test("derives the least-privilege union for modeled Target resources", () => {
    const oauthProviderArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
      "token-vault/default/oauth2credentialprovider/calendar";
    const apiKeyProviderArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
      "token-vault/default/apikeycredentialprovider/weather";
    const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:calendar";
    const lambdaArn = "arn:aws:lambda:us-west-2:123456789012:function:calculator";
    const runtimeArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders";
    const configurations: GatewayTargetRoleConfiguration[] = [
      {
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn,
              toolSchema: { s3: { uri: "s3://schemas/calculator.json" } },
            },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: {
            apiGateway: {
              restApiId: "api123",
              stage: "prod",
              apiGatewayToolConfiguration: {
                toolFilters: [{ filterPath: "/orders", methods: ["GET"] }],
              },
            },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: {
            connector: {
              source: { connectorId: "bedrock-knowledge-bases" },
              configurations: [
                {
                  name: "Retrieve",
                  parameterValues: { knowledgeBaseId: "KB12345678" },
                },
                {
                  name: "AgenticRetrieveStream",
                  parameterValues: {
                    retrievers: [
                      {
                        configuration: {
                          knowledgeBase: { knowledgeBaseId: "KB87654321" },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: { connector: { source: { connectorId: "web-search" } } },
        },
      },
      {
        targetConfiguration: {
          http: { agentcoreRuntime: { arn: runtimeArn, qualifier: "prod" } },
        },
      },
      {
        targetConfiguration: {
          inference: {
            connector: { source: { connectorId: "bedrock-mantle" } },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: { mcpServer: { endpoint: "https://calendar.example.test/mcp" } },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "OAUTH",
            credentialProvider: {
              oauthCredentialProvider: {
                providerArn: oauthProviderArn,
                scopes: ["calendar.read"],
              },
            },
          },
          {
            credentialProviderType: "API_KEY",
            credentialProvider: {
              apiKeyCredentialProvider: { providerArn: apiKeyProviderArn },
            },
          },
        ],
        credentialProviderSecretArns: [secretArn],
      },
    ];

    const statements = policyStatements(
      GatewayExecutionPolicy.forTargets(configurations, {
        partition: "aws",
        region: REGION,
        accountId: ACCOUNT_ID,
        gatewayId: "orders-abc",
        workloadIdentityArn: WORKLOAD_IDENTITY_ARN,
      }),
    );
    const bySid = new Map(statements.map((statement) => [statement.Sid, statement]));

    expect([...bySid.keys()]).toEqual([
      "AgentCoreGatewayTargetAgenticRetrieve",
      "AgentCoreGatewayTargetApiGateway",
      "AgentCoreGatewayTargetApiKey",
      "AgentCoreGatewayTargetBedrockMantle",
      "AgentCoreGatewayTargetCredentialSecrets",
      "AgentCoreGatewayTargetKnowledgeBase",
      "AgentCoreGatewayTargetLambda",
      "AgentCoreGatewayTargetOAuth",
      "AgentCoreGatewayTargetOAuthCompleteAuth",
      "AgentCoreGatewayTargetRuntime",
      "AgentCoreGatewayTargetS3Schema",
      "AgentCoreGatewayTargetWebSearch",
      "AgentCoreGatewayTargetWorkloadIdentity",
    ]);
    expect(bySid.get("AgentCoreGatewayTargetLambda")?.Resource).toEqual([
      lambdaArn,
      `${lambdaArn}:*`,
    ]);
    expect(bySid.get("AgentCoreGatewayTargetRuntime")?.Resource).toEqual([
      runtimeArn,
      `${runtimeArn}/runtime-endpoint/prod`,
    ]);
    expect(bySid.get("AgentCoreGatewayTargetS3Schema")?.Resource).toEqual([
      "arn:aws:s3:::schemas/calculator.json",
    ]);
    expect(bySid.get("AgentCoreGatewayTargetCredentialSecrets")?.Resource).toEqual([secretArn]);
  });

  test("rejects role-based Targets whose permissions cannot be inferred", () => {
    expect(() =>
      GatewayExecutionPolicy.forTargets(
        [
          {
            targetConfiguration: {
              http: {
                passthrough: {
                  endpoint: "https://api.example.test",
                  protocolType: "CUSTOM",
                },
              },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "GATEWAY_IAM_ROLE",
                credentialProvider: {
                  iamCredentialProvider: {
                    service: "execute-api",
                    region: REGION,
                  },
                },
              },
            ],
          },
        ],
        {
          partition: "aws",
          region: REGION,
          accountId: ACCOUNT_ID,
          gatewayId: "orders-abc",
        },
      ),
    ).toThrow("cannot infer least-privilege IAM permissions");
  });

  test("merges CLI policy statements by Sid without dropping resources", () => {
    const current = GatewayExecutionPolicy.parse(
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AgentCoreGatewayTargetLambda",
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: "arn:aws:lambda:us-west-2:123456789012:function:first",
          },
        ],
      }),
    );
    const candidate = GatewayExecutionPolicy.forTargets(
      [
        {
          targetConfiguration: {
            mcp: {
              lambda: {
                lambdaArn: "arn:aws:lambda:us-west-2:123456789012:function:second",
                toolSchema: { inlinePayload: [] },
              },
            },
          },
        },
      ],
      {
        partition: "aws",
        region: REGION,
        accountId: ACCOUNT_ID,
        gatewayId: "orders-abc",
      },
    );

    expect(policyStatements(current.merge(candidate))[0]!.Resource).toEqual([
      "arn:aws:lambda:us-west-2:123456789012:function:first",
      "arn:aws:lambda:us-west-2:123456789012:function:second",
      "arn:aws:lambda:us-west-2:123456789012:function:second:*",
    ]);
  });
});

describe("Gateway role propagation retry", () => {
  test("retries role propagation errors up to the configured limit", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await expect(
      retryWhileGatewayRoleChangesPropagate(
        async () => {
          attempts += 1;
          const error = new Error("Gateway execution role cannot be assumed");
          error.name = "ValidationException";
          throw error;
        },
        3,
        10,
        async (delay) => {
          delays.push(delay);
        },
      ),
    ).rejects.toThrow("cannot be assumed");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 10]);
  });

  test("does not retry unrelated failures", async () => {
    let attempts = 0;
    const error = new Error("target rejected");

    await expect(
      retryWhileGatewayRoleChangesPropagate(async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});
