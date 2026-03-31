import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetEvaluatorCommand,
  GetMemoryCommand,
  GetOnlineEvaluationConfigCommand,
  ListAgentRuntimesCommand,
  ListEvaluatorsCommand,
  ListMemoriesCommand,
  UpdateOnlineEvaluationConfigCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export interface GetAgentRuntimeStatusOptions {
  region: string;
  runtimeId: string;
}

export interface AgentRuntimeStatusResult {
  runtimeId: string;
  status: string;
}

/**
 * Fetch the status of an AgentCore Runtime by runtime ID.
 */
export async function getAgentRuntimeStatus(options: GetAgentRuntimeStatusOptions): Promise<AgentRuntimeStatusResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetAgentRuntimeCommand({
    agentRuntimeId: options.runtimeId,
  });

  const response = await client.send(command);

  if (!response.status) {
    throw new Error(`No status returned for runtime ${options.runtimeId}`);
  }

  return {
    runtimeId: options.runtimeId,
    status: response.status,
  };
}

// ============================================================================
// Agent Runtimes — List & Get
// ============================================================================

export interface ListAgentRuntimesOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface AgentRuntimeSummary {
  agentRuntimeId: string;
  agentRuntimeArn: string;
  agentRuntimeName: string;
  description: string;
  status: string;
  lastUpdatedAt?: Date;
}

export interface ListAgentRuntimesResult {
  runtimes: AgentRuntimeSummary[];
  nextToken?: string;
}

/**
 * List all AgentCore Runtimes in the given region.
 */
export async function listAgentRuntimes(options: ListAgentRuntimesOptions): Promise<ListAgentRuntimesResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new ListAgentRuntimesCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await client.send(command);

  return {
    runtimes: (response.agentRuntimes ?? []).map(r => ({
      agentRuntimeId: r.agentRuntimeId ?? '',
      agentRuntimeArn: r.agentRuntimeArn ?? '',
      agentRuntimeName: r.agentRuntimeName ?? '',
      description: r.description ?? '',
      status: r.status ?? 'UNKNOWN',
      lastUpdatedAt: r.lastUpdatedAt,
    })),
    nextToken: response.nextToken,
  };
}

export interface GetAgentRuntimeOptions {
  region: string;
  runtimeId: string;
}

export interface AgentRuntimeDetail {
  agentRuntimeId: string;
  agentRuntimeArn: string;
  agentRuntimeName: string;
  status: string;
  description?: string;
  roleArn: string;
  networkMode: string;
  networkConfig?: { subnets: string[]; securityGroups: string[] };
  protocol: string;
  runtimeVersion?: string;
  entryPoint?: string[];
  build: 'CodeZip' | 'Container';
  authorizerType?: string;
  authorizerConfiguration?: {
    customJwtAuthorizer?: {
      discoveryUrl: string;
      allowedAudience?: string[];
      allowedClients?: string[];
      allowedScopes?: string[];
    };
  };
}

/**
 * Get full details of an AgentCore Runtime by ID.
 */
export async function getAgentRuntimeDetail(options: GetAgentRuntimeOptions): Promise<AgentRuntimeDetail> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetAgentRuntimeCommand({
    agentRuntimeId: options.runtimeId,
  });

  const response = await client.send(command);

  const networkMode = response.networkConfiguration?.networkMode ?? 'PUBLIC';
  const networkConfig =
    networkMode === 'VPC' && response.networkConfiguration?.networkModeConfig
      ? {
          subnets: response.networkConfiguration.networkModeConfig.subnets ?? [],
          securityGroups: response.networkConfiguration.networkModeConfig.securityGroups ?? [],
        }
      : undefined;

  const isContainer = !!response.agentRuntimeArtifact?.containerConfiguration;
  const codeConfig = response.agentRuntimeArtifact?.codeConfiguration;

  let authorizerType: string | undefined;
  let authorizerConfiguration: AgentRuntimeDetail['authorizerConfiguration'];
  if (response.authorizerConfiguration?.customJWTAuthorizer) {
    authorizerType = 'CUSTOM_JWT';
    const jwt = response.authorizerConfiguration.customJWTAuthorizer;
    authorizerConfiguration = {
      customJwtAuthorizer: {
        discoveryUrl: jwt.discoveryUrl ?? '',
        allowedAudience: jwt.allowedAudience,
        allowedClients: jwt.allowedClients,
        allowedScopes: jwt.allowedScopes,
      },
    };
  }

  return {
    agentRuntimeId: response.agentRuntimeId ?? '',
    agentRuntimeArn: response.agentRuntimeArn ?? '',
    agentRuntimeName: response.agentRuntimeName ?? '',
    status: response.status ?? 'UNKNOWN',
    description: response.description,
    roleArn: response.roleArn ?? '',
    networkMode,
    networkConfig,
    protocol: response.protocolConfiguration?.serverProtocol ?? 'HTTP',
    runtimeVersion: codeConfig?.runtime,
    entryPoint: codeConfig?.entryPoint,
    build: isContainer ? 'Container' : 'CodeZip',
    authorizerType,
    authorizerConfiguration,
  };
}

// ============================================================================
// Memories — List & Get
// ============================================================================

export interface ListMemoriesOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface MemorySummary {
  memoryId: string;
  memoryArn: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ListMemoriesResult {
  memories: MemorySummary[];
  nextToken?: string;
}

/**
 * List all AgentCore Memories in the given region.
 */
export async function listMemories(options: ListMemoriesOptions): Promise<ListMemoriesResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new ListMemoriesCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await client.send(command);

  return {
    memories: (response.memories ?? []).map(m => ({
      memoryId: m.id ?? '',
      memoryArn: m.arn ?? '',
      status: m.status ?? 'UNKNOWN',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    nextToken: response.nextToken,
  };
}

export interface GetMemoryOptions {
  region: string;
  memoryId: string;
}

export interface MemoryDetail {
  memoryId: string;
  memoryArn: string;
  name: string;
  status: string;
  description?: string;
  eventExpiryDuration: number;
  strategies: {
    type: string;
    name?: string;
    description?: string;
    namespaces?: string[];
    reflectionNamespaces?: string[];
  }[];
}

/**
 * Get full details of an AgentCore Memory by ID.
 */
export async function getMemoryDetail(options: GetMemoryOptions): Promise<MemoryDetail> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetMemoryCommand({
    memoryId: options.memoryId,
  });

  const response = await client.send(command);
  const memory = response.memory;

  if (!memory) {
    throw new Error(`No memory found for ID ${options.memoryId}`);
  }

  if (!memory.id) {
    throw new Error(`Memory ${options.memoryId} is missing required field: id`);
  }
  if (!memory.arn) {
    throw new Error(`Memory ${options.memoryId} is missing required field: arn`);
  }
  if (!memory.name) {
    throw new Error(`Memory ${options.memoryId} is missing required field: name`);
  }
  if (memory.eventExpiryDuration == null) {
    throw new Error(`Memory ${options.memoryId} is missing required field: eventExpiryDuration`);
  }

  return {
    memoryId: memory.id,
    memoryArn: memory.arn,
    name: memory.name,
    status: memory.status ?? 'UNKNOWN',
    description: memory.description,
    eventExpiryDuration: memory.eventExpiryDuration,
    strategies: (memory.strategies ?? []).map(s => {
      if (!s.type) {
        throw new Error(`Memory ${options.memoryId} has a strategy with missing required field: type`);
      }
      const episodicNamespaces = s.configuration?.reflection?.episodicReflectionConfiguration?.namespaces;
      return {
        type: s.type,
        name: s.name,
        description: s.description,
        namespaces: s.namespaces,
        ...(episodicNamespaces && episodicNamespaces.length > 0 && { reflectionNamespaces: episodicNamespaces }),
      };
    }),
  };
}

// ============================================================================
// Evaluator
// ============================================================================

export interface GetEvaluatorOptions {
  region: string;
  evaluatorId: string;
}

export interface GetEvaluatorResult {
  evaluatorId: string;
  evaluatorArn: string;
  evaluatorName: string;
  level: string;
  status: string;
  description?: string;
}

export async function getEvaluator(options: GetEvaluatorOptions): Promise<GetEvaluatorResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetEvaluatorCommand({
    evaluatorId: options.evaluatorId,
  });

  const response = await client.send(command);

  if (!response.evaluatorId) {
    throw new Error(`No evaluator found for ID ${options.evaluatorId}`);
  }

  return {
    evaluatorId: response.evaluatorId,
    evaluatorArn: response.evaluatorArn ?? '',
    evaluatorName: response.evaluatorName ?? '',
    level: response.level ?? 'SESSION',
    status: response.status ?? 'UNKNOWN',
    description: response.description,
  };
}

export interface ListEvaluatorsOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface EvaluatorSummary {
  evaluatorId: string;
  evaluatorArn: string;
  evaluatorName: string;
  evaluatorType: string;
  level?: string;
  status: string;
  description?: string;
}

export interface ListEvaluatorsResult {
  evaluators: EvaluatorSummary[];
  nextToken?: string;
}

export async function listEvaluators(options: ListEvaluatorsOptions): Promise<ListEvaluatorsResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new ListEvaluatorsCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await client.send(command);

  return {
    evaluators: (response.evaluators ?? []).map(e => ({
      evaluatorId: e.evaluatorId ?? '',
      evaluatorArn: e.evaluatorArn ?? '',
      evaluatorName: e.evaluatorName ?? '',
      evaluatorType: e.evaluatorType ?? 'Custom',
      level: e.level,
      status: e.status ?? 'UNKNOWN',
      description: e.description,
    })),
    nextToken: response.nextToken,
  };
}

// ============================================================================
// Online Eval Config
// ============================================================================

export type OnlineEvalExecutionStatus = 'ENABLED' | 'DISABLED';

export interface UpdateOnlineEvalStatusOptions {
  region: string;
  onlineEvaluationConfigId: string;
  executionStatus: OnlineEvalExecutionStatus;
}

export interface UpdateOnlineEvalOptions {
  region: string;
  onlineEvaluationConfigId: string;
  executionStatus?: OnlineEvalExecutionStatus;
}

export interface UpdateOnlineEvalStatusResult {
  configId: string;
  executionStatus: string;
  status: string;
}

/**
 * Update the execution status of an online evaluation config (pause/resume).
 */
export async function updateOnlineEvalExecutionStatus(
  options: UpdateOnlineEvalStatusOptions
): Promise<UpdateOnlineEvalStatusResult> {
  return updateOnlineEvalConfig(options);
}

/**
 * Update an online evaluation config with any supported fields.
 */
export async function updateOnlineEvalConfig(options: UpdateOnlineEvalOptions): Promise<UpdateOnlineEvalStatusResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new UpdateOnlineEvaluationConfigCommand({
    onlineEvaluationConfigId: options.onlineEvaluationConfigId,
    ...(options.executionStatus && { executionStatus: options.executionStatus }),
  });

  const response = await client.send(command);

  return {
    configId: response.onlineEvaluationConfigId ?? options.onlineEvaluationConfigId,
    executionStatus: response.executionStatus ?? options.executionStatus ?? 'UNKNOWN',
    status: response.status ?? 'UNKNOWN',
  };
}

export interface GetOnlineEvalConfigOptions {
  region: string;
  configId: string;
}

export interface GetOnlineEvalConfigResult {
  configId: string;
  configArn: string;
  configName: string;
  status: string;
  executionStatus: string;
  description?: string;
  failureReason?: string;
  outputLogGroupName?: string;
}

export async function getOnlineEvaluationConfig(
  options: GetOnlineEvalConfigOptions
): Promise<GetOnlineEvalConfigResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetOnlineEvaluationConfigCommand({
    onlineEvaluationConfigId: options.configId,
  });

  const response = await client.send(command);

  if (!response.onlineEvaluationConfigId) {
    throw new Error(`No online evaluation config found for ID ${options.configId}`);
  }

  const logGroupName = response.outputConfig?.cloudWatchConfig?.logGroupName;

  return {
    configId: response.onlineEvaluationConfigId,
    configArn: response.onlineEvaluationConfigArn ?? '',
    configName: response.onlineEvaluationConfigName ?? '',
    status: response.status ?? 'UNKNOWN',
    executionStatus: response.executionStatus ?? 'UNKNOWN',
    description: response.description,
    failureReason: response.failureReason,
    outputLogGroupName: logGroupName,
  };
}
