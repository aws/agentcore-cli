import { describe, expect, test } from "bun:test";
import {
  CreateRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import {
  ensureGatewayExecutionRole,
  gatewayExecutionRoleName,
  GATEWAY_EXECUTION_POLICY_NAME,
  GATEWAY_ROLE_MANAGED_BY_TAG,
  GATEWAY_ROLE_RESOURCE_TYPE_TAG,
  getManagedGatewayTargetExecutionRole,
  retryWhileGatewayRoleChangesPropagate,
  type GatewayTargetRoleConfiguration,
} from "./gatewayExecutionRole";

type SentCommand = {
  input: Record<string, any>;
  constructor: { name: string };
};

const ACCOUNT_ID = "123456789012";
const REGION = "us-west-2";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const POLICY_ENGINE_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders-policy";
const INTERCEPTOR_ARN = "arn:aws:lambda:us-west-2:123456789012:function:interceptor";
const TRANSFORM_ARN = "arn:aws:lambda:us-west-2:123456789012:function:transform";

function noSuchEntity(): Error {
  const error = new Error("not found");
  error.name = "NoSuchEntityException";
  return error;
}

function alreadyExists(): Error {
  const error = new Error("already exists");
  error.name = "EntityAlreadyExistsException";
  return error;
}

function ownedRole(roleName: string) {
  return {
    Path: "/",
    RoleName: roleName,
    RoleId: "AROATEST",
    Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
    CreateDate: new Date("2026-08-03T00:00:00Z"),
    Tags: [GATEWAY_ROLE_MANAGED_BY_TAG, GATEWAY_ROLE_RESOURCE_TYPE_TAG],
  };
}

function fakeIam(send: (command: SentCommand) => Promise<unknown>): IAMClient {
  return { send } as unknown as IAMClient;
}

function requiredString(value: string | undefined): string {
  expect(value).toBeString();
  return value!;
}

function policyStatements(policyDocument: string): Record<string, any>[] {
  return JSON.parse(policyDocument).Statement;
}

describe("Gateway execution role ownership", () => {
  test("derives deterministic collision-resistant names within IAM limits", () => {
    const longName = "A".repeat(48);

    expect(gatewayExecutionRoleName(longName, REGION).length).toBeLessThanOrEqual(64);
    expect(gatewayExecutionRoleName("orders", REGION)).toBe(
      gatewayExecutionRoleName("orders", REGION),
    );
    expect(gatewayExecutionRoleName("orders", REGION)).not.toBe(
      gatewayExecutionRoleName("Orders", REGION),
    );
    expect(gatewayExecutionRoleName("orders", REGION)).not.toBe(
      gatewayExecutionRoleName("orders", "us-east-1"),
    );
    expect(gatewayExecutionRoleName(`${"a".repeat(32)}-one`, REGION)).not.toBe(
      gatewayExecutionRoleName(`${"a".repeat(32)}-two`, REGION),
    );
  });

  test("creates, tags, scopes, and finalizes a least-privilege role", async () => {
    const sent: SentCommand[] = [];
    const iam = fakeIam(async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) throw noSuchEntity();
      if (command instanceof CreateRoleCommand) {
        return { Role: ownedRole(requiredString(command.input.RoleName)) };
      }
      return {};
    });

    const provisioning = await ensureGatewayExecutionRole(iam, "orders", REGION, {
      policyEngineConfiguration: { arn: POLICY_ENGINE_ARN, mode: "ENFORCE" },
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: INTERCEPTOR_ARN } },
          interceptionPoints: ["REQUEST"],
        },
      ],
    });
    await provisioning.updatePolicy();
    await provisioning.updateTrust(GATEWAY_ARN);
    await provisioning.updatePolicy(GATEWAY_ARN);

    const create = sent.find((command) => command instanceof CreateRoleCommand)!;
    const bootstrapTrust = JSON.parse(requiredString(create.input.AssumeRolePolicyDocument))
      .Statement[0];
    expect(bootstrapTrust).toMatchObject({
      Effect: "Deny",
      Principal: { Service: "bedrock-agentcore.amazonaws.com" },
      Action: "sts:AssumeRole",
    });
    expect(create.input.Tags).toContainEqual(GATEWAY_ROLE_MANAGED_BY_TAG);
    expect(create.input.Tags).toContainEqual(GATEWAY_ROLE_RESOURCE_TYPE_TAG);

    const trustUpdates = sent.filter((command) => command instanceof UpdateAssumeRolePolicyCommand);
    expect(trustUpdates).toHaveLength(2);
    expect(
      JSON.parse(requiredString(trustUpdates[0]!.input.PolicyDocument)).Statement[0].Condition,
    ).toEqual({
      StringEquals: { "aws:SourceAccount": ACCOUNT_ID },
      ArnLike: {
        "aws:SourceArn": `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/orders-*`,
      },
    });
    expect(
      JSON.parse(requiredString(trustUpdates[1]!.input.PolicyDocument)).Statement[0].Condition
        .ArnLike,
    ).toEqual({ "aws:SourceArn": GATEWAY_ARN });

    const policyUpdates = sent.filter((command) => command instanceof PutRolePolicyCommand);
    expect(policyUpdates).toHaveLength(2);
    expect(policyUpdates.map(({ input }) => input.PolicyName)).toEqual([
      GATEWAY_EXECUTION_POLICY_NAME,
      GATEWAY_EXECUTION_POLICY_NAME,
    ]);
    const prepared = policyStatements(requiredString(policyUpdates[0]!.input.PolicyDocument));
    const finalized = policyStatements(requiredString(policyUpdates[1]!.input.PolicyDocument));
    expect(prepared.find(({ Sid }) => Sid === "AgentCoreGatewayConfigLambda")).toMatchObject({
      Action: "lambda:InvokeFunction",
      Resource: [INTERCEPTOR_ARN],
    });
    expect(prepared.find(({ Sid }) => Sid === "AgentCoreGatewayConfigPolicyEngine")).toMatchObject({
      Action: "bedrock-agentcore:GetPolicyEngine",
      Resource: POLICY_ENGINE_ARN,
    });
    expect(
      prepared.find(({ Sid }) => Sid === "AgentCoreGatewayConfigPolicyAuthorization"),
    ).toMatchObject({
      Action: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      Resource: [
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/orders-*`,
        POLICY_ENGINE_ARN,
      ],
    });
    expect(prepared.find(({ Sid }) => Sid === "AgentCoreGatewayConfigGuardrail")).toMatchObject({
      Action: "bedrock:InvokeGuardrailChecks",
      Resource: "*",
    });

    expect(
      finalized.find(({ Sid }) => Sid === "AgentCoreGatewayConfigPolicyAuthorization")!.Resource,
    ).toEqual([GATEWAY_ARN, POLICY_ENGINE_ARN]);
  });

  test("refuses to adopt an untagged role with the generated name", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const iam = fakeIam(async (command) => {
      if (command instanceof GetRoleCommand) {
        return { Role: { ...ownedRole(roleName), Tags: [] } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });

    await expect(ensureGatewayExecutionRole(iam, "orders", REGION, {})).rejects.toThrow(
      "not managed by the agentcore CLI",
    );
  });

  test("rechecks ownership after a concurrent creator wins the role-name race", async () => {
    const sent: SentCommand[] = [];
    const roleName = gatewayExecutionRoleName("orders", REGION);
    let getRoleCalls = 0;
    const iam = fakeIam(async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) {
        getRoleCalls += 1;
        if (getRoleCalls === 1) throw noSuchEntity();
        return { Role: ownedRole(roleName) };
      }
      if (command instanceof CreateRoleCommand) throw alreadyExists();
      return {};
    });

    const provisioning = await ensureGatewayExecutionRole(iam, "orders", REGION, {});

    expect(provisioning.roleArn).toBe(`arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`);
    expect(sent.map((command) => command.constructor.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
      "GetRoleCommand",
      "UpdateAssumeRolePolicyCommand",
    ]);
  });

  test("omits an inline policy when the Gateway requires no execution permissions", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const sent: SentCommand[] = [];
    const iam = fakeIam(async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) return { Role: ownedRole(roleName) };
      if (command instanceof DeleteRolePolicyCommand) throw noSuchEntity();
      return {};
    });

    const provisioning = await ensureGatewayExecutionRole(iam, "orders", REGION, {});
    await provisioning.updatePolicy();
    await provisioning.updatePolicy(GATEWAY_ARN);

    expect(sent.filter((command) => command instanceof PutRolePolicyCommand)).toHaveLength(0);
    expect(sent.filter((command) => command instanceof DeleteRolePolicyCommand)).toHaveLength(2);
  });

  test("derives least-privilege permissions for modeled Target resources", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const sent: SentCommand[] = [];
    const iam = fakeIam(async (command) => {
      sent.push(command);
      if (command instanceof GetRoleCommand) {
        return { Role: ownedRole(roleName) };
      }
      if (command instanceof PutRolePolicyCommand) return {};
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const lambdaArn = "arn:aws:lambda:us-west-2:123456789012:function:target";
    const runtimeArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/runtime-1";
    const oauthProviderArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/oauth";
    const apiKeyProviderArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/key";
    const workloadIdentityArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:" +
      "workload-identity-directory/default/workload-identity/orders-workload";
    const workloadIdentityDirectoryArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default";
    const tokenVaultArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default";
    const configurations: GatewayTargetRoleConfiguration[] = [
      {
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn,
              toolSchema: { s3: { uri: "s3://schemas/lambda.json" } },
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
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      },
      {
        targetConfiguration: {
          inference: {
            connector: {
              source: { connectorId: "bedrock-mantle" },
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      },
      {
        targetConfiguration: {
          mcp: {
            openApiSchema: { s3: { uri: "s3://schemas/openapi.json" } },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: {
            apiGateway: {
              restApiId: "api123",
              stage: "prod",
              apiGatewayToolConfiguration: { toolFilters: [] },
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      },
      {
        targetConfiguration: {
          http: {
            agentcoreRuntime: {
              arn: runtimeArn,
              qualifier: "LIVE",
              schema: { source: { s3: { uri: "s3://schemas/runtime.json" } } },
            },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: {
            connector: {
              source: { connectorId: "web-search" },
            },
          },
        },
      },
      {
        targetConfiguration: {
          mcp: { mcpServer: { endpoint: "https://example.com/mcp" } },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "OAUTH",
            credentialProvider: {
              oauthCredentialProvider: {
                providerArn: oauthProviderArn,
                scopes: ["read"],
                grantType: "TOKEN_EXCHANGE",
              },
            },
          },
          {
            credentialProviderType: "API_KEY",
            credentialProvider: {
              apiKeyCredentialProvider: {
                providerArn: apiKeyProviderArn,
              },
            },
          },
        ],
        credentialProviderSecretArns: [
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:oauth",
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:api-key",
        ],
      },
    ];

    const role = await getManagedGatewayTargetExecutionRole(
      iam,
      {
        gatewayId: "orders-abc123",
        gatewayArn: GATEWAY_ARN,
        name: "orders",
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
        workloadIdentityDetails: { workloadIdentityArn },
        interceptorConfigurations: [
          {
            interceptor: { lambda: { arn: INTERCEPTOR_ARN } },
            interceptionPoints: ["REQUEST"],
          },
        ],
        customTransformConfiguration: { lambda: { arn: TRANSFORM_ARN } },
      } as Parameters<typeof getManagedGatewayTargetExecutionRole>[1],
      REGION,
    );
    await role!.updatePolicy(configurations);

    const policyUpdate = sent.find((command) => command instanceof PutRolePolicyCommand);
    const statements = policyStatements(requiredString(policyUpdate?.input.PolicyDocument));
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayConfigLambda")).toMatchObject({
      Action: "lambda:InvokeFunction",
      Resource: [INTERCEPTOR_ARN, TRANSFORM_ARN].sort(),
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetLambda")).toMatchObject({
      Action: "lambda:InvokeFunction",
      Resource: [lambdaArn, `${lambdaArn}:*`],
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetS3Schema")).toMatchObject({
      Action: "s3:GetObject",
      Resource: [
        "arn:aws:s3:::schemas/lambda.json",
        "arn:aws:s3:::schemas/openapi.json",
        "arn:aws:s3:::schemas/runtime.json",
      ],
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetApiGateway")).toMatchObject({
      Action: "execute-api:Invoke",
      Resource: ["arn:aws:execute-api:us-west-2:123456789012:api123/prod/*/*"],
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetRuntime")).toMatchObject({
      Action: "bedrock-agentcore:InvokeAgentRuntime",
      Resource: [runtimeArn, `${runtimeArn}/runtime-endpoint/LIVE`],
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetWebSearch")).toMatchObject({
      Action: "bedrock-agentcore:InvokeWebSearch",
      Resource: "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1",
    });
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetKnowledgeBase"),
    ).toMatchObject({
      Action: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
      Resource: [
        "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB12345678",
        "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB87654321",
      ],
    });
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetAgenticRetrieve"),
    ).toMatchObject({
      Action: "bedrock:AgenticRetrieveStream",
      Resource: "*",
    });
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetBedrockMantle"),
    ).toMatchObject({
      Action: "bedrock-mantle:CreateInference",
      Resource: "*",
    });
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetWorkloadIdentity"),
    ).toMatchObject({
      Action: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
      ],
      Resource: [workloadIdentityDirectoryArn, workloadIdentityArn],
    });
    const oauthResources = [
      tokenVaultArn,
      oauthProviderArn,
      workloadIdentityDirectoryArn,
      workloadIdentityArn,
    ].sort();
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetOAuthCompleteAuth"),
    ).toMatchObject({
      Action: "bedrock-agentcore:CompleteResourceTokenAuth",
      Resource: oauthResources,
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetOAuth")).toMatchObject({
      Action: "bedrock-agentcore:GetResourceOauth2Token",
      Resource: oauthResources,
    });
    expect(statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetApiKey")).toMatchObject({
      Action: "bedrock-agentcore:GetResourceApiKey",
      Resource: [
        tokenVaultArn,
        apiKeyProviderArn,
        workloadIdentityDirectoryArn,
        workloadIdentityArn,
      ].sort(),
    });
    expect(
      statements.find(({ Sid }) => Sid === "AgentCoreGatewayTargetCredentialSecrets"),
    ).toMatchObject({
      Action: "secretsmanager:GetSecretValue",
      Resource: [
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:api-key",
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:oauth",
      ],
    });
  });

  test("requires a customer-managed role when SigV4 permissions cannot be inferred", async () => {
    const roleName = gatewayExecutionRoleName("orders", REGION);
    const iam = fakeIam(async (command) => {
      if (command instanceof GetRoleCommand) return { Role: ownedRole(roleName) };
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    const role = await getManagedGatewayTargetExecutionRole(
      iam,
      {
        gatewayId: "orders-abc123",
        gatewayArn: GATEWAY_ARN,
        name: "orders",
        roleArn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
      } as Parameters<typeof getManagedGatewayTargetExecutionRole>[1],
      REGION,
    );

    for (const configuration of [
      {
        targetConfiguration: {
          http: {
            passthrough: {
              endpoint: "https://service.us-west-2.amazonaws.com",
              protocolType: "CUSTOM",
            },
          },
        },
        credentialProviderConfigurations: [
          {
            credentialProviderType: "GATEWAY_IAM_ROLE",
            credentialProvider: {
              iamCredentialProvider: {
                service: "service",
                region: REGION,
              },
            },
          },
        ],
      },
      {
        targetConfiguration: {
          mcp: {
            smithyModel: {
              inlinePayload: JSON.stringify({
                smithy: "2.0",
                shapes: {},
              }),
            },
          },
        },
      },
    ] satisfies GatewayTargetRoleConfiguration[]) {
      await expect(role!.updatePolicy([configuration])).rejects.toThrow(
        "customer-managed --role-arn",
      );
    }
  });
});

describe("Gateway role propagation retry", () => {
  test("retries only role-assumption validation failures up to the configured limit", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retryWhileGatewayRoleChangesPropagate(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("The execution role cannot be assumed yet");
          error.name = "ValidationException";
          throw error;
        }
        return "created";
      },
      3,
      25,
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(result).toBe("created");
    expect(attempts).toBe(3);
    expect(delays).toEqual([25, 25]);
  });

  test("does not retry unrelated failures", async () => {
    let attempts = 0;

    await expect(
      retryWhileGatewayRoleChangesPropagate(
        async () => {
          attempts += 1;
          throw new Error("access denied");
        },
        3,
        0,
        async () => {},
      ),
    ).rejects.toThrow("access denied");
    expect(attempts).toBe(1);
  });
});
