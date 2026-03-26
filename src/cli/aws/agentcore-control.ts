import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetEvaluatorCommand,
  GetOnlineEvaluationConfigCommand,
  ListEvaluatorsCommand,
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
