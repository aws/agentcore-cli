import type { EvaluationLevel } from '../../schema/schemas/primitives/evaluator';
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
  ListOnlineEvaluationConfigsCommand,
  ListTagsForResourceCommand,
  UpdateOnlineEvaluationConfigCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

/**
 * Create a shared BedrockAgentCoreControlClient for the given region.
 * Callers should create one client and reuse it across related operations
 * to benefit from connection pooling and credential caching.
 */
export function createControlClient(region: string): BedrockAgentCoreControlClient {
  return new BedrockAgentCoreControlClient({
    region,
    credentials: getCredentialProvider(),
  });
}

/**
 * Paginate through all pages of a list API and collect every item.
 * Reuses a single client for connection pooling across pages.
 */
async function paginateAll<T>(
  region: string,
  fetchPage: (
    options: { region: string; maxResults: number; nextToken?: string },
    client: BedrockAgentCoreControlClient
  ) => Promise<{ items: T[]; nextToken?: string }>
): Promise<T[]> {
  const client = createControlClient(region);
  const items: T[] = [];
  let nextToken: string | undefined;

  do {
    const result = await fetchPage({ region, maxResults: 100, nextToken }, client);
    items.push(...result.items);
    nextToken = result.nextToken;
  } while (nextToken);

  return items;
}

/**
 * Fetch tags for a resource by ARN. Returns undefined when the ARN is missing,
 * the resource has no tags, or the ListTagsForResource call fails.
 */
async function fetchTags(
  client: BedrockAgentCoreControlClient,
  resourceArn: string | undefined,
  resourceLabel: string
): Promise<Record<string, string> | undefined> {
  if (!resourceArn) return undefined;
  try {
    const response = await client.send(new ListTagsForResourceCommand({ resourceArn }));
    if (response.tags && Object.keys(response.tags).length > 0) {
      return response.tags;
    }
  } catch (err) {
    console.warn(
      `Warning: Failed to fetch tags for ${resourceLabel}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return undefined;
}

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
  const client = createControlClient(options.region);

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
export async function listAgentRuntimes(
  options: ListAgentRuntimesOptions,
  client?: BedrockAgentCoreControlClient
): Promise<ListAgentRuntimesResult> {
  const resolvedClient = client ?? createControlClient(options.region);

  const command = new ListAgentRuntimesCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await resolvedClient.send(command);

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

/**
 * List all AgentCore Runtimes in the given region, paginating through all pages.
 */
export async function listAllAgentRuntimes(options: { region: string }): Promise<AgentRuntimeSummary[]> {
  return paginateAll(options.region, async (opts, client) => {
    const result = await listAgentRuntimes(opts, client);
    return { items: result.runtimes, nextToken: result.nextToken };
  });
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
  environmentVariables?: Record<string, string>;
  tags?: Record<string, string>;
  lifecycleConfiguration?: { idleRuntimeSessionTimeout?: number; maxLifetime?: number };
  requestHeaderAllowlist?: string[];
}

/**
 * Get full details of an AgentCore Runtime by ID.
 */
export async function getAgentRuntimeDetail(options: GetAgentRuntimeOptions): Promise<AgentRuntimeDetail> {
  const client = createControlClient(options.region);

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

  // Extract environment variables
  const environmentVariables =
    response.environmentVariables && Object.keys(response.environmentVariables).length > 0
      ? response.environmentVariables
      : undefined;

  // Extract lifecycle configuration
  const lifecycleConfiguration = response.lifecycleConfiguration
    ? {
        idleRuntimeSessionTimeout: response.lifecycleConfiguration.idleRuntimeSessionTimeout,
        maxLifetime: response.lifecycleConfiguration.maxLifetime,
      }
    : undefined;

  // Extract request header allowlist from the union type
  let requestHeaderAllowlist: string[] | undefined;
  if (response.requestHeaderConfiguration && 'requestHeaderAllowlist' in response.requestHeaderConfiguration) {
    const allowlist = response.requestHeaderConfiguration.requestHeaderAllowlist;
    if (allowlist && allowlist.length > 0) {
      requestHeaderAllowlist = allowlist;
    }
  }

  const tags = await fetchTags(client, response.agentRuntimeArn, 'runtime');

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
    environmentVariables,
    tags,
    lifecycleConfiguration,
    requestHeaderAllowlist,
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
export async function listMemories(
  options: ListMemoriesOptions,
  client?: BedrockAgentCoreControlClient
): Promise<ListMemoriesResult> {
  const resolvedClient = client ?? createControlClient(options.region);

  const command = new ListMemoriesCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await resolvedClient.send(command);

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

/**
 * List all AgentCore Memories in the given region, paginating through all pages.
 */
export async function listAllMemories(options: { region: string }): Promise<MemorySummary[]> {
  return paginateAll(options.region, async (opts, client) => {
    const result = await listMemories(opts, client);
    return { items: result.memories, nextToken: result.nextToken };
  });
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
  tags?: Record<string, string>;
  encryptionKeyArn?: string;
  executionRoleArn?: string;
}

/**
 * Get full details of an AgentCore Memory by ID.
 */
export async function getMemoryDetail(options: GetMemoryOptions): Promise<MemoryDetail> {
  const client = createControlClient(options.region);

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

  const tags = await fetchTags(client, memory.arn, 'memory');

  return {
    memoryId: memory.id,
    memoryArn: memory.arn,
    name: memory.name,
    status: memory.status ?? 'UNKNOWN',
    description: memory.description,
    eventExpiryDuration: memory.eventExpiryDuration,
    tags,
    encryptionKeyArn: memory.encryptionKeyArn,
    executionRoleArn: memory.memoryExecutionRoleArn,
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

export interface GetEvaluatorLlmConfig {
  model: string;
  instructions: string;
  ratingScale: {
    numerical?: { value: number; label: string; definition: string }[];
    categorical?: { label: string; definition: string }[];
  };
}

export interface GetEvaluatorCodeBasedConfig {
  lambdaArn: string;
}

export interface GetEvaluatorResult {
  evaluatorId: string;
  evaluatorArn: string;
  evaluatorName: string;
  level: EvaluationLevel;
  status: string;
  description?: string;
  evaluatorConfig?: {
    llmAsAJudge?: GetEvaluatorLlmConfig;
    codeBased?: GetEvaluatorCodeBasedConfig;
  };
  tags?: Record<string, string>;
}

export async function getEvaluator(options: GetEvaluatorOptions): Promise<GetEvaluatorResult> {
  const client = createControlClient(options.region);

  const command = new GetEvaluatorCommand({
    evaluatorId: options.evaluatorId,
  });

  let response;
  try {
    response = await client.send(command);
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'ResourceNotFoundException' || name === 'ValidationException') {
      throw new Error(`Evaluator "${options.evaluatorId}" not found. Verify the evaluator ID or ARN is correct.`);
    }
    throw err;
  }

  if (!response.evaluatorId) {
    throw new Error(`No evaluator found for ID ${options.evaluatorId}`);
  }

  // Map SDK evaluatorConfig union to flat optional-field format
  let evaluatorConfig: GetEvaluatorResult['evaluatorConfig'];
  if (response.evaluatorConfig) {
    if ('llmAsAJudge' in response.evaluatorConfig && response.evaluatorConfig.llmAsAJudge) {
      const llm = response.evaluatorConfig.llmAsAJudge;
      // AWS API nests model ID under modelConfig.bedrockEvaluatorModelConfig.modelId;
      // CLI schema flattens this to config.llmAsAJudge.model
      let model = '';
      if (
        llm.modelConfig &&
        'bedrockEvaluatorModelConfig' in llm.modelConfig &&
        llm.modelConfig.bedrockEvaluatorModelConfig
      ) {
        model = llm.modelConfig.bedrockEvaluatorModelConfig.modelId ?? '';
      }
      const ratingScale: GetEvaluatorLlmConfig['ratingScale'] = {};
      if (llm.ratingScale) {
        if ('numerical' in llm.ratingScale && llm.ratingScale.numerical) {
          ratingScale.numerical = llm.ratingScale.numerical.map(n => ({
            value: n.value ?? 0,
            label: n.label ?? '',
            definition: n.definition ?? '',
          }));
        } else if ('categorical' in llm.ratingScale && llm.ratingScale.categorical) {
          ratingScale.categorical = llm.ratingScale.categorical.map(c => ({
            label: c.label ?? '',
            definition: c.definition ?? '',
          }));
        }
      }
      evaluatorConfig = {
        llmAsAJudge: { model, instructions: llm.instructions ?? '', ratingScale },
      };
    } else if ('codeBased' in response.evaluatorConfig && response.evaluatorConfig.codeBased) {
      const cb = response.evaluatorConfig.codeBased;
      if ('lambdaConfig' in cb && cb.lambdaConfig) {
        evaluatorConfig = {
          codeBased: { lambdaArn: cb.lambdaConfig.lambdaArn ?? '' },
        };
      }
    }
  }

  const tags = await fetchTags(client, response.evaluatorArn, 'evaluator');

  return {
    evaluatorId: response.evaluatorId,
    evaluatorArn: response.evaluatorArn ?? '',
    evaluatorName: response.evaluatorName ?? '',
    level: (response.level ?? 'SESSION') as EvaluationLevel,
    status: response.status ?? 'UNKNOWN',
    description: response.description,
    evaluatorConfig,
    tags,
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

export async function listEvaluators(
  options: ListEvaluatorsOptions,
  client?: BedrockAgentCoreControlClient
): Promise<ListEvaluatorsResult> {
  const resolvedClient = client ?? createControlClient(options.region);

  const command = new ListEvaluatorsCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await resolvedClient.send(command);

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

/**
 * List all custom evaluators in the given region, paginating through all pages.
 * Filters out Builtin evaluators — only custom evaluators can be imported.
 */
export async function listAllEvaluators(options: { region: string }): Promise<EvaluatorSummary[]> {
  return paginateAll(options.region, async (opts, client) => {
    const result = await listEvaluators(opts, client);
    return {
      items: result.evaluators.filter(e => !e.evaluatorName.startsWith('Builtin.')),
      nextToken: result.nextToken,
    };
  });
}

// ============================================================================
// Online Eval Config — List
// ============================================================================

export interface ListOnlineEvalConfigsOptions {
  region: string;
  maxResults?: number;
  nextToken?: string;
}

export interface OnlineEvalConfigSummary {
  onlineEvaluationConfigId: string;
  onlineEvaluationConfigArn: string;
  onlineEvaluationConfigName: string;
  description?: string;
  status: string;
  executionStatus: string;
}

export interface ListOnlineEvalConfigsResult {
  configs: OnlineEvalConfigSummary[];
  nextToken?: string;
}

export async function listOnlineEvaluationConfigs(
  options: ListOnlineEvalConfigsOptions,
  client?: BedrockAgentCoreControlClient
): Promise<ListOnlineEvalConfigsResult> {
  const resolvedClient = client ?? createControlClient(options.region);

  const command = new ListOnlineEvaluationConfigsCommand({
    maxResults: options.maxResults,
    nextToken: options.nextToken,
  });

  const response = await resolvedClient.send(command);

  return {
    configs: (response.onlineEvaluationConfigs ?? []).map(c => ({
      onlineEvaluationConfigId: c.onlineEvaluationConfigId ?? '',
      onlineEvaluationConfigArn: c.onlineEvaluationConfigArn ?? '',
      onlineEvaluationConfigName: c.onlineEvaluationConfigName ?? '',
      description: c.description,
      status: c.status ?? 'UNKNOWN',
      executionStatus: c.executionStatus ?? 'UNKNOWN',
    })),
    nextToken: response.nextToken,
  };
}

/**
 * List all online evaluation configs in the given region, paginating through all pages.
 */
export async function listAllOnlineEvaluationConfigs(options: { region: string }): Promise<OnlineEvalConfigSummary[]> {
  return paginateAll(options.region, async (opts, client) => {
    const result = await listOnlineEvaluationConfigs(opts, client);
    return { items: result.configs, nextToken: result.nextToken };
  });
}

// ============================================================================
// Online Eval Config — Update / Get
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
  const client = createControlClient(options.region);

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
  /** Sampling percentage from the rule config */
  samplingPercentage?: number;
  /** Service names from CloudWatch data source config (e.g. "projectName_agentName.DEFAULT") */
  serviceNames?: string[];
  /** Evaluator IDs referenced by this config */
  evaluatorIds?: string[];
}

export async function getOnlineEvaluationConfig(
  options: GetOnlineEvalConfigOptions
): Promise<GetOnlineEvalConfigResult> {
  const client = createControlClient(options.region);

  const command = new GetOnlineEvaluationConfigCommand({
    onlineEvaluationConfigId: options.configId,
  });

  const response = await client.send(command);

  if (!response.onlineEvaluationConfigId) {
    throw new Error(`No online evaluation config found for ID ${options.configId}`);
  }

  const logGroupName = response.outputConfig?.cloudWatchConfig?.logGroupName;
  const samplingPercentage = response.rule?.samplingConfig?.samplingPercentage;
  const serviceNames =
    response.dataSourceConfig && 'cloudWatchLogs' in response.dataSourceConfig
      ? response.dataSourceConfig.cloudWatchLogs?.serviceNames
      : undefined;
  const evaluatorIds = (response.evaluators ?? [])
    .map(e => ('evaluatorId' in e ? e.evaluatorId : undefined))
    .filter((id): id is string => !!id);

  return {
    configId: response.onlineEvaluationConfigId,
    configArn: response.onlineEvaluationConfigArn ?? '',
    configName: response.onlineEvaluationConfigName ?? '',
    status: response.status ?? 'UNKNOWN',
    executionStatus: response.executionStatus ?? 'UNKNOWN',
    description: response.description,
    failureReason: response.failureReason,
    outputLogGroupName: logGroupName,
    samplingPercentage,
    serviceNames,
    evaluatorIds,
  };
}
