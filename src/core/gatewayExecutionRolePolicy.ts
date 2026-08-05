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

export class GatewayExecutionPolicy {
  private constructor(private readonly document: PolicyDocument) {}

  static empty(): GatewayExecutionPolicy {
    return new GatewayExecutionPolicy(policyDocument([]));
  }

  static parse(value: string | undefined): GatewayExecutionPolicy {
    if (!value) return GatewayExecutionPolicy.empty();

    let parsed: { Statement?: PolicyStatement | PolicyStatement[] };
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = JSON.parse(decodeURIComponent(value));
    }
    const statements = parsed.Statement
      ? Array.isArray(parsed.Statement)
        ? parsed.Statement
        : [parsed.Statement]
      : [];
    return new GatewayExecutionPolicy(policyDocument(statements));
  }

  static forGateway(
    configuration: GatewayRoleConfiguration,
    gatewayArn: string,
  ): GatewayExecutionPolicy {
    return new GatewayExecutionPolicy(
      policyDocument(configurationStatements(configuration, gatewayArn)),
    );
  }

  static forTargets(
    configurations: GatewayTargetRoleConfiguration[],
    context: GatewayTargetPolicyContext,
  ): GatewayExecutionPolicy {
    return new GatewayExecutionPolicy(policyDocument(targetStatements(configurations, context)));
  }

  merge(candidate: GatewayExecutionPolicy): GatewayExecutionPolicy {
    const statements = [...this.document.Statement];
    for (const requested of candidate.document.Statement) {
      const index = requested.Sid ? statements.findIndex(({ Sid }) => Sid === requested.Sid) : -1;
      if (index === -1) {
        statements.push(requested);
      } else {
        statements[index] = mergeStatements(statements[index]!, requested);
      }
    }
    return new GatewayExecutionPolicy(policyDocument(statements));
  }

  equals(other: GatewayExecutionPolicy): boolean {
    return JSON.stringify(this.document) === JSON.stringify(other.document);
  }

  toJSON(): string | undefined {
    return this.document.Statement.length > 0 ? JSON.stringify(this.document) : undefined;
  }
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
  addResourceStatement(
    statements,
    `${GATEWAY_POLICY_SCOPE}Lambda`,
    "lambda:InvokeFunction",
    lambdaArns,
  );
  return statements;
}

function targetStatements(
  configurations: GatewayTargetRoleConfiguration[],
  context: GatewayTargetPolicyContext,
): PolicyStatement[] {
  const resources = {
    lambda: new Set<string>(),
    s3: new Set<string>(),
    apiGateway: new Set<string>(),
    runtime: new Set<string>(),
    knowledgeBase: new Set<string>(),
    oauthProvider: new Set<string>(),
    apiKeyProvider: new Set<string>(),
    secret: new Set<string>(),
  };
  let usesWebSearch = false;
  let usesAgenticRetrieve = false;
  let usesBedrockMantle = false;

  for (const configuration of configurations) {
    const target = configuration.targetConfiguration;
    let roleRequested = false;
    let roleSupported = false;

    if (target && "mcp" in target && target.mcp) {
      const mcp = target.mcp;
      if ("lambda" in mcp && mcp.lambda) {
        roleRequested = usesGatewayRole(configuration, true);
        roleSupported = true;
        if (roleRequested && mcp.lambda.lambdaArn) {
          resources.lambda.add(mcp.lambda.lambdaArn);
          if (isUnqualifiedLambdaFunctionArn(mcp.lambda.lambdaArn)) {
            resources.lambda.add(`${mcp.lambda.lambdaArn}:*`);
          }
        }
        addSchemaS3Object(resources.s3, mcp.lambda.toolSchema, context.partition);
      } else if ("openApiSchema" in mcp && mcp.openApiSchema) {
        roleRequested = usesGatewayRole(configuration, false);
        addSchemaS3Object(resources.s3, mcp.openApiSchema, context.partition);
      } else if ("smithyModel" in mcp && mcp.smithyModel) {
        roleRequested = usesGatewayRole(configuration, true);
        addSchemaS3Object(resources.s3, mcp.smithyModel, context.partition);
      } else if ("mcpServer" in mcp && mcp.mcpServer) {
        roleRequested = usesGatewayRole(configuration, false);
        addSchemaS3Object(resources.s3, mcp.mcpServer.mcpToolSchema, context.partition);
      } else if ("apiGateway" in mcp && mcp.apiGateway) {
        roleRequested = usesGatewayRole(configuration, true);
        roleSupported = true;
        if (roleRequested) {
          resources.apiGateway.add(
            `arn:${context.partition}:execute-api:${context.region}:${context.accountId}:` +
              `${mcp.apiGateway.restApiId}/${mcp.apiGateway.stage}/*/*`,
          );
        }
      } else if ("connector" in mcp && mcp.connector) {
        const connectorId = mcp.connector.source?.connectorId;
        const hasKnownRole = ["web-search", "bedrock-knowledge-bases"].includes(connectorId ?? "");
        roleRequested = usesGatewayRole(configuration, hasKnownRole);
        roleSupported = hasKnownRole;
        if (roleRequested && connectorId === "web-search") {
          usesWebSearch = true;
        } else if (roleRequested && connectorId === "bedrock-knowledge-bases") {
          usesAgenticRetrieve =
            addKnowledgeBaseConnectorPermissions(
              resources.knowledgeBase,
              mcp.connector.configurations,
              context,
            ) || usesAgenticRetrieve;
        }
      }
    } else if (target && "http" in target && target.http) {
      const http = target.http;
      if ("agentcoreRuntime" in http && http.agentcoreRuntime) {
        roleRequested = usesGatewayRole(configuration, true);
        roleSupported = true;
        if (roleRequested && http.agentcoreRuntime.arn) {
          resources.runtime.add(http.agentcoreRuntime.arn);
          resources.runtime.add(
            `${http.agentcoreRuntime.arn}/runtime-endpoint/` +
              `${http.agentcoreRuntime.qualifier ?? "DEFAULT"}`,
          );
        }
        addSchemaS3Object(resources.s3, http.agentcoreRuntime.schema?.source, context.partition);
      } else if ("passthrough" in http && http.passthrough) {
        roleRequested = usesGatewayRole(configuration, false);
        addSchemaS3Object(resources.s3, http.passthrough.schema?.source, context.partition);
      }
    } else if (target && "inference" in target && target.inference) {
      const inference = target.inference;
      const isMantle =
        ("connector" in inference &&
          inference.connector?.source?.connectorId === "bedrock-mantle") ||
        ("provider" in inference &&
          inference.provider?.endpoint?.includes("bedrock-mantle.") === true);
      roleRequested = usesGatewayRole(configuration, isMantle);
      roleSupported = isMantle;
      usesBedrockMantle = usesBedrockMantle || (roleRequested && isMantle);
    } else {
      roleRequested = usesGatewayRole(configuration, false);
    }

    if (roleRequested && !roleSupported) {
      throw new InputValidationError(
        "The CLI cannot infer least-privilege IAM permissions for this Target's " +
          "GATEWAY_IAM_ROLE credential; use a customer-managed Gateway --role-arn",
      );
    }

    collectCredentialResources(configuration, resources);
  }

  const statements: PolicyStatement[] = [];
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}Lambda`,
    "lambda:InvokeFunction",
    resources.lambda,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}S3Schema`,
    "s3:GetObject",
    resources.s3,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}ApiGateway`,
    "execute-api:Invoke",
    resources.apiGateway,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}Runtime`,
    "bedrock-agentcore:InvokeAgentRuntime",
    resources.runtime,
  );
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}KnowledgeBase`,
    ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
    resources.knowledgeBase,
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
    resources.oauthProvider.size > 0 || resources.apiKeyProvider.size > 0
      ? workloadIdentityResources(context)
      : [];
  if (workloadIdentityArns.length > 0) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}WorkloadIdentity`,
      Effect: "Allow",
      Action: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        ...(resources.oauthProvider.size > 0
          ? [
              "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
              "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
            ]
          : []),
      ].sort(),
      Resource: workloadIdentityArns,
    });
  }
  if (resources.oauthProvider.size > 0) {
    const targetResources = tokenVaultResources(
      context,
      resources.oauthProvider,
      workloadIdentityArns,
    );
    statements.push(
      {
        Sid: `${GATEWAY_TARGET_POLICY_SCOPE}OAuthCompleteAuth`,
        Effect: "Allow",
        Action: "bedrock-agentcore:CompleteResourceTokenAuth",
        Resource: targetResources,
      },
      {
        Sid: `${GATEWAY_TARGET_POLICY_SCOPE}OAuth`,
        Effect: "Allow",
        Action: "bedrock-agentcore:GetResourceOauth2Token",
        Resource: targetResources,
      },
    );
  }
  if (resources.apiKeyProvider.size > 0) {
    statements.push({
      Sid: `${GATEWAY_TARGET_POLICY_SCOPE}ApiKey`,
      Effect: "Allow",
      Action: "bedrock-agentcore:GetResourceApiKey",
      Resource: tokenVaultResources(context, resources.apiKeyProvider, workloadIdentityArns),
    });
  }
  addResourceStatement(
    statements,
    `${GATEWAY_TARGET_POLICY_SCOPE}CredentialSecrets`,
    "secretsmanager:GetSecretValue",
    resources.secret,
  );
  return statements;
}

function usesGatewayRole(
  configuration: GatewayTargetRoleConfiguration,
  byDefault: boolean,
): boolean {
  if (configuration.credentialProviderConfigurations === undefined) return byDefault;
  return configuration.credentialProviderConfigurations.some(
    ({ credentialProviderType }) => credentialProviderType === "GATEWAY_IAM_ROLE",
  );
}

function collectCredentialResources(
  configuration: GatewayTargetRoleConfiguration,
  resources: {
    oauthProvider: Set<string>;
    apiKeyProvider: Set<string>;
    secret: Set<string>;
  },
): void {
  for (const providerConfiguration of configuration.credentialProviderConfigurations ?? []) {
    const provider = providerConfiguration.credentialProvider;
    if (
      providerConfiguration.credentialProviderType === "OAUTH" &&
      provider &&
      "oauthCredentialProvider" in provider &&
      provider.oauthCredentialProvider?.providerArn
    ) {
      resources.oauthProvider.add(provider.oauthCredentialProvider.providerArn);
    } else if (
      providerConfiguration.credentialProviderType === "API_KEY" &&
      provider &&
      "apiKeyCredentialProvider" in provider &&
      provider.apiKeyCredentialProvider?.providerArn
    ) {
      resources.apiKeyProvider.add(provider.apiKeyCredentialProvider.providerArn);
    }
  }
  for (const secretArn of configuration.credentialProviderSecretArns ?? []) {
    resources.secret.add(secretArn);
  }
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
  return [workloadIdentityArn.slice(0, markerIndex), workloadIdentityArn].sort();
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

function mergeStatements(current: PolicyStatement, requested: PolicyStatement): PolicyStatement {
  return {
    ...current,
    ...requested,
    Action: unionValues(current.Action, requested.Action),
    Resource: unionValues(current.Resource, requested.Resource),
  };
}

function unionValues(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): string | string[] | undefined {
  const values = new Set([...asArray(left), ...asArray(right)]);
  if (values.size === 0) return undefined;
  const result = [...values].sort();
  return result.length === 1 ? result[0] : result;
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function policyDocument(statements: PolicyStatement[]): PolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: statements.sort((left, right) => (left.Sid ?? "").localeCompare(right.Sid ?? "")),
  };
}
