import type {
  CreateGatewayTargetRequest,
  GetGatewayResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";

const GATEWAY_POLICY_SCOPE = "AgentCoreGatewayConfig";
const GATEWAY_TARGET_POLICY_SCOPE = "AgentCoreGatewayTarget";

export type GatewayRoleConfiguration = {
  customTransformConfiguration?: GetGatewayResponse["customTransformConfiguration"];
  interceptorConfigurations?: GetGatewayResponse["interceptorConfigurations"];
  policyEngineConfiguration?: GetGatewayResponse["policyEngineConfiguration"];
};

export type GatewayTargetRoleConfiguration = Pick<
  CreateGatewayTargetRequest,
  "targetConfiguration" | "credentialProviderConfigurations"
> & {
  credentialProviderSecretArns?: string[];
};

export type GatewayTargetPolicyContext = {
  partition: string;
  region: string;
  accountId: string;
  gatewayId: string;
  workloadIdentityArn?: string;
};

type PolicyStatement = {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[];
  [key: string]: unknown;
};

type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

export function gatewayPolicyDocument(
  configuration: GatewayRoleConfiguration,
  gatewayArn: string,
): string | undefined {
  return policyDocumentForStatements(configurationStatements(configuration, gatewayArn));
}

export function gatewayTargetPolicyDocument(
  gateway: GatewayRoleConfiguration,
  gatewayArn: string,
  configurations: GatewayTargetRoleConfiguration[],
  context: GatewayTargetPolicyContext,
): string | undefined {
  return policyDocumentForStatements([
    ...configurationStatements(gateway, gatewayArn),
    ...targetStatements(configurations, context),
  ]);
}

function configurationStatements(
  configuration: GatewayRoleConfiguration,
  gatewayArn: string,
): PolicyStatement[] {
  const statements: PolicyStatement[] = [];
  const policyEngineArn = configuration.policyEngineConfiguration?.arn;
  if (policyEngineArn) {
    statements.push(
      {
        Sid: `${GATEWAY_POLICY_SCOPE}PolicyEngine`,
        Effect: "Allow",
        Action: "bedrock-agentcore:GetPolicyEngine",
        Resource: policyEngineArn,
      },
      {
        Sid: `${GATEWAY_POLICY_SCOPE}PolicyAuthorization`,
        Effect: "Allow",
        Action: [
          "bedrock-agentcore:AuthorizeAction",
          "bedrock-agentcore:PartiallyAuthorizeActions",
        ],
        Resource: [policyEngineArn, gatewayArn].sort(),
      },
      {
        Sid: `${GATEWAY_POLICY_SCOPE}Guardrail`,
        Effect: "Allow",
        Action: "bedrock:InvokeGuardrailChecks",
        Resource: "*",
      },
    );
  }

  const lambdaArns = new Set<string>();
  for (const interceptor of configuration.interceptorConfigurations ?? []) {
    const interceptorConfiguration = interceptor.interceptor;
    const interceptorArn =
      interceptorConfiguration &&
      "lambda" in interceptorConfiguration &&
      interceptorConfiguration.lambda
        ? interceptorConfiguration.lambda.arn
        : undefined;
    if (interceptorArn) lambdaArns.add(interceptorArn);
  }
  const transformArn = configuration.customTransformConfiguration?.lambda?.arn;
  if (transformArn) lambdaArns.add(transformArn);
  if (lambdaArns.size > 0) {
    statements.push({
      Sid: `${GATEWAY_POLICY_SCOPE}Lambda`,
      Effect: "Allow",
      Action: "lambda:InvokeFunction",
      Resource: [...lambdaArns].sort(),
    });
  }

  return statements;
}

function targetStatements(
  configurations: GatewayTargetRoleConfiguration[],
  context: GatewayTargetPolicyContext,
): PolicyStatement[] {
  const lambdaArns = new Set<string>();
  const s3ObjectArns = new Set<string>();
  const apiGatewayArns = new Set<string>();
  const runtimeArns = new Set<string>();
  const knowledgeBaseArns = new Set<string>();
  const oauthProviderArns = new Set<string>();
  const apiKeyProviderArns = new Set<string>();
  const secretArns = new Set<string>();
  let usesWebSearch = false;
  let usesAgenticRetrieve = false;
  let usesBedrockMantle = false;

  for (const configuration of configurations) {
    const target = configuration.targetConfiguration;
    assertSupportedGatewayRoleTarget(configuration);
    if (target && "mcp" in target && target.mcp) {
      const mcp = target.mcp;
      if ("lambda" in mcp && mcp.lambda) {
        const lambdaArn = mcp.lambda.lambdaArn;
        if (lambdaArn) {
          lambdaArns.add(lambdaArn);
          if (isUnqualifiedLambdaFunctionArn(lambdaArn)) {
            lambdaArns.add(`${lambdaArn}:*`);
          }
        }
        addSchemaS3Object(s3ObjectArns, mcp.lambda.toolSchema, context.partition);
      } else if ("openApiSchema" in mcp && mcp.openApiSchema) {
        addSchemaS3Object(s3ObjectArns, mcp.openApiSchema, context.partition);
      } else if ("smithyModel" in mcp && mcp.smithyModel) {
        addSchemaS3Object(s3ObjectArns, mcp.smithyModel, context.partition);
      } else if ("mcpServer" in mcp && mcp.mcpServer) {
        addSchemaS3Object(s3ObjectArns, mcp.mcpServer.mcpToolSchema, context.partition);
      } else if ("apiGateway" in mcp && mcp.apiGateway) {
        if (usesGatewayExecutionRole(configuration)) {
          apiGatewayArns.add(
            `arn:${context.partition}:execute-api:${context.region}:${context.accountId}:` +
              `${mcp.apiGateway.restApiId}/${mcp.apiGateway.stage}/*/*`,
          );
        }
      } else if ("connector" in mcp && mcp.connector) {
        const connectorId = mcp.connector.source?.connectorId;
        if (connectorId === "web-search") {
          usesWebSearch = usesWebSearch || usesGatewayExecutionRole(configuration);
        } else if (connectorId === "bedrock-knowledge-bases") {
          if (usesGatewayExecutionRole(configuration)) {
            usesAgenticRetrieve =
              addKnowledgeBaseConnectorPermissions(
                knowledgeBaseArns,
                mcp.connector.configurations,
                context,
              ) || usesAgenticRetrieve;
          }
        }
      }
    } else if (target && "http" in target && target.http) {
      const http = target.http;
      if ("agentcoreRuntime" in http && http.agentcoreRuntime) {
        const runtimeArn = http.agentcoreRuntime.arn;
        if (runtimeArn && usesGatewayExecutionRole(configuration)) {
          runtimeArns.add(runtimeArn);
          runtimeArns.add(
            `${runtimeArn}/runtime-endpoint/${http.agentcoreRuntime.qualifier ?? "DEFAULT"}`,
          );
        }
        addSchemaS3Object(s3ObjectArns, http.agentcoreRuntime.schema?.source, context.partition);
      } else if ("passthrough" in http && http.passthrough) {
        addSchemaS3Object(s3ObjectArns, http.passthrough.schema?.source, context.partition);
      }
    } else if (target && "inference" in target && target.inference) {
      usesBedrockMantle =
        usesBedrockMantle ||
        (usesGatewayExecutionRole(configuration) &&
          (("connector" in target.inference &&
            target.inference.connector?.source?.connectorId === "bedrock-mantle") ||
            ("provider" in target.inference &&
              target.inference.provider?.endpoint?.includes("bedrock-mantle.") === true)));
    }

    for (const providerConfiguration of configuration.credentialProviderConfigurations ?? []) {
      const provider = providerConfiguration.credentialProvider;
      if (
        providerConfiguration.credentialProviderType === "OAUTH" &&
        provider &&
        "oauthCredentialProvider" in provider &&
        provider.oauthCredentialProvider
      ) {
        if (provider.oauthCredentialProvider.providerArn) {
          oauthProviderArns.add(provider.oauthCredentialProvider.providerArn);
        }
      } else if (
        providerConfiguration.credentialProviderType === "API_KEY" &&
        provider &&
        "apiKeyCredentialProvider" in provider &&
        provider.apiKeyCredentialProvider?.providerArn
      ) {
        apiKeyProviderArns.add(provider.apiKeyCredentialProvider.providerArn);
      }
    }
    for (const secretArn of configuration.credentialProviderSecretArns ?? []) {
      secretArns.add(secretArn);
    }
  }

  const statements: PolicyStatement[] = [];
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}Lambda`,
    "lambda:InvokeFunction",
    lambdaArns,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}S3Schema`,
    "s3:GetObject",
    s3ObjectArns,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}ApiGateway`,
    "execute-api:Invoke",
    apiGatewayArns,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}Runtime`,
    "bedrock-agentcore:InvokeAgentRuntime",
    runtimeArns,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}KnowledgeBase`,
    ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
    knowledgeBaseArns,
  );
  if (usesAgenticRetrieve) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}AgenticRetrieve`,
      Effect: "Allow",
      Action: "bedrock:AgenticRetrieveStream",
      Resource: "*",
    });
  }
  if (usesBedrockMantle) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}BedrockMantle`,
      Effect: "Allow",
      Action: "bedrock-mantle:CreateInference",
      Resource: "*",
    });
  }
  if (usesWebSearch) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}WebSearch`,
      Effect: "Allow",
      Action: "bedrock-agentcore:InvokeWebSearch",
      Resource: `arn:${context.partition}:bedrock-agentcore:${context.region}:aws:tool/web-search.v1`,
    });
  }

  const workloadIdentityArns =
    oauthProviderArns.size > 0 || apiKeyProviderArns.size > 0
      ? workloadIdentityResources(context)
      : [];
  if (workloadIdentityArns.length > 0) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}WorkloadIdentity`,
      Effect: "Allow",
      Action: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        ...(oauthProviderArns.size > 0
          ? [
              "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
              "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
            ]
          : []),
      ].sort(),
      Resource: workloadIdentityArns,
    });
  }
  if (oauthProviderArns.size > 0) {
    const resources = tokenVaultResources(context, oauthProviderArns, workloadIdentityArns);
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}OAuthCompleteAuth`,
      Effect: "Allow",
      Action: "bedrock-agentcore:CompleteResourceTokenAuth",
      Resource: resources,
    });
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}OAuth`,
      Effect: "Allow",
      Action: "bedrock-agentcore:GetResourceOauth2Token",
      Resource: resources,
    });
  }
  if (apiKeyProviderArns.size > 0) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}ApiKey`,
      Effect: "Allow",
      Action: "bedrock-agentcore:GetResourceApiKey",
      Resource: tokenVaultResources(context, apiKeyProviderArns, workloadIdentityArns),
    });
  }
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}CredentialSecrets`,
    "secretsmanager:GetSecretValue",
    secretArns,
  );

  return statements;
}

function workloadIdentityResources(context: GatewayTargetPolicyContext): string[] {
  const workloadIdentityArn = context.workloadIdentityArn;
  if (!workloadIdentityArn) {
    throw new Error(
      `Gateway "${context.gatewayId}" did not return a workload identity ARN required for Target credentials`,
    );
  }
  const marker = "/workload-identity/";
  const markerIndex = workloadIdentityArn.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Invalid Gateway workload identity ARN "${workloadIdentityArn}"`);
  }
  const directoryArn = workloadIdentityArn.slice(0, markerIndex);
  return [directoryArn, workloadIdentityArn].sort();
}

function tokenVaultResources(
  context: GatewayTargetPolicyContext,
  providerArns: Set<string>,
  workloadIdentityArns: string[],
): string[] {
  const tokenVaultArn =
    `arn:${context.partition}:bedrock-agentcore:${context.region}:${context.accountId}:` +
    "token-vault/default";
  return [...new Set([tokenVaultArn, ...providerArns, ...workloadIdentityArns])].sort();
}

function assertSupportedGatewayRoleTarget(configuration: GatewayTargetRoleConfiguration): void {
  if (!usesGatewayExecutionRole(configuration)) return;
  const target = configuration.targetConfiguration;
  const supported =
    Boolean(target && "mcp" in target && target.mcp && "lambda" in target.mcp) ||
    Boolean(target && "mcp" in target && target.mcp && "apiGateway" in target.mcp) ||
    Boolean(
      target &&
      "mcp" in target &&
      target.mcp &&
      "connector" in target.mcp &&
      ["bedrock-knowledge-bases", "web-search"].includes(
        target.mcp.connector?.source?.connectorId ?? "",
      ),
    ) ||
    Boolean(target && "http" in target && target.http && "agentcoreRuntime" in target.http) ||
    Boolean(
      target &&
      "inference" in target &&
      target.inference &&
      (("connector" in target.inference &&
        target.inference.connector?.source?.connectorId === "bedrock-mantle") ||
        ("provider" in target.inference &&
          target.inference.provider?.endpoint?.includes("bedrock-mantle.") === true)),
    );
  if (supported) return;

  throw new InputValidationError(
    "The CLI cannot infer least-privilege IAM permissions for this Target's " +
      "GATEWAY_IAM_ROLE credential; update the Gateway to use a customer-managed --role-arn",
  );
}

function isUnqualifiedLambdaFunctionArn(arn: string): boolean {
  return /^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+$/.test(arn);
}

function addKnowledgeBaseConnectorPermissions(
  resources: Set<string>,
  configurations:
    | {
        name?: string;
        parameterValues?: unknown;
      }[]
    | undefined,
  context: GatewayTargetPolicyContext,
): boolean {
  let usesAgenticRetrieve = false;
  for (const configuration of configurations ?? []) {
    const parameterValues = asRecord(configuration.parameterValues);
    if (configuration.name === "Retrieve") {
      addKnowledgeBaseArn(resources, parameterValues?.knowledgeBaseId, context);
    } else if (configuration.name === "AgenticRetrieveStream") {
      usesAgenticRetrieve = true;
      const retrievers = parameterValues?.retrievers;
      if (!Array.isArray(retrievers)) continue;
      for (const retriever of retrievers) {
        const retrieverConfiguration = asRecord(asRecord(retriever)?.configuration);
        const knowledgeBase = asRecord(retrieverConfiguration?.knowledgeBase);
        addKnowledgeBaseArn(resources, knowledgeBase?.knowledgeBaseId, context);
      }
    }
  }
  return usesAgenticRetrieve;
}

function addKnowledgeBaseArn(
  resources: Set<string>,
  knowledgeBaseId: unknown,
  context: GatewayTargetPolicyContext,
): void {
  if (typeof knowledgeBaseId !== "string" || !knowledgeBaseId) return;
  resources.add(
    `arn:${context.partition}:bedrock:${context.region}:${context.accountId}:` +
      `knowledge-base/${knowledgeBaseId}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function addSchemaS3Object(
  resources: Set<string>,
  schema: { s3?: { uri?: string } } | undefined,
  partition: string,
): void {
  const uri = schema?.s3?.uri;
  if (!uri) return;
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (match) resources.add(`arn:${partition}:s3:::${match[1]}/${match[2]}`);
}

function usesGatewayExecutionRole(configuration: GatewayTargetRoleConfiguration): boolean {
  if (configuration.credentialProviderConfigurations !== undefined) {
    return configuration.credentialProviderConfigurations.some(
      ({ credentialProviderType }) => credentialProviderType === "GATEWAY_IAM_ROLE",
    );
  }

  const target = configuration.targetConfiguration;
  return Boolean(
    target &&
    (("mcp" in target &&
      target.mcp &&
      ("lambda" in target.mcp ||
        "smithyModel" in target.mcp ||
        "apiGateway" in target.mcp ||
        ("connector" in target.mcp &&
          ["bedrock-knowledge-bases", "web-search"].includes(
            target.mcp.connector?.source?.connectorId ?? "",
          )))) ||
      ("http" in target && target.http && "agentcoreRuntime" in target.http) ||
      ("inference" in target &&
        target.inference &&
        (("connector" in target.inference &&
          target.inference.connector?.source?.connectorId === "bedrock-mantle") ||
          ("provider" in target.inference &&
            target.inference.provider?.endpoint?.includes("bedrock-mantle.") === true)))),
  );
}

function addResourceStatement(
  statements: PolicyStatement[],
  sid: string,
  action: string | string[],
  resources: Set<string>,
): void {
  if (resources.size === 0) return;
  statements.push({
    Sid: sid,
    Effect: "Allow",
    Action: action,
    Resource: [...resources].sort(),
  });
}

function policyDocumentForStatements(statements: PolicyStatement[]): string | undefined {
  if (statements.length === 0) return undefined;
  const document: PolicyDocument = { Version: "2012-10-17", Statement: statements };
  return JSON.stringify(document);
}
