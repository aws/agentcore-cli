/**
 * Orchestrates running a BatchEvaluation:
 *   1. Resolve agent from deployed state (for serviceNames / logGroupNames)
 *   2. Build evaluators + dataSourceConfig
 *   3. Call StartBatchEvaluation
 *   4. Poll GetBatchEvaluation until terminal status
 *   5. Return results
 */
import { ConfigIO, ResourceNotFoundError, ValidationError, toError } from '../../../lib';
import type { Result } from '../../../lib/result';
import type { DeployedState } from '../../../schema';
import { generateClientToken, getBatchEvaluation, startBatchEvaluation } from '../../aws/agentcore-batch-evaluation';
import type {
  CloudWatchFilterConfig,
  EvaluationResults,
  GetBatchEvaluationResult,
  SessionMetadataEntry,
} from '../../aws/agentcore-batch-evaluation';
import { resolveEndpointName, runtimeLogGroup } from '../../aws/cloudwatch';
import { getRegion } from '../../commands/shared/region-utils';
import { ExecLogger } from '../../logging/exec-logger';
import { resolveAgentContext } from '../invoke/resolve-agent-context';
import { runDatasetScenarios } from './shared/dataset-session-provider';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

// ============================================================================
// Types
// ============================================================================

export interface RunBatchEvaluationOptions {
  /** Agent name (from project config) */
  agent: string;
  /** Evaluator IDs (Builtin.* or custom) */
  evaluators: string[];
  /** Optional name for the batch evaluation */
  name?: string;
  /** Region override */
  region?: string;
  /** Specific session IDs to evaluate (optional — filters CloudWatch source) */
  sessionIds?: string[];
  /** Lookback window in days (optional — filters CloudWatch source by time range) */
  lookbackDays?: number;
  /** Session metadata with ground truth (assertions, expected trajectory, turns) */
  sessionMetadata?: SessionMetadataEntry[];
  /** Poll interval in ms */
  pollIntervalMs?: number;
  /** Progress callback */
  onProgress?: (status: string, message: string) => void;
  /** Called once the batch evaluation has been created, with ID and region for cancellation */
  onStarted?: (info: { batchEvaluationId: string; region: string }) => void;
  /** Dataset name — invoke agent with dataset scenarios before batch evaluation */
  dataset?: string;
  /** Dataset version (omit for local file, or N/DRAFT) */
  datasetVersion?: string;
  /** Runtime endpoint name (e.g. PROMPT_V1). Defaults to DEFAULT. */
  endpoint?: string;
}

export interface BatchEvaluationResult {
  evaluatorId: string;
  score?: number;
  label?: string;
  explanation?: string;
  error?: string;
}

export type RunBatchEvaluationCommandResult = Result & {
  batchEvaluationId?: string;
  name?: string;
  status?: string;
  results: BatchEvaluationResult[];
  evaluationResults?: EvaluationResults;
  startedAt?: string;
  completedAt?: string;
  logFilePath?: string;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Delay before submitting batch eval to allow CloudWatch span ingestion. Matches SDK default. */
const BATCH_INGESTION_DELAY_MS = 180_000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'STOPPED', 'CANCELLED']);

// ============================================================================
// Implementation
// ============================================================================

export async function runBatchEvaluationCommand(
  options: RunBatchEvaluationOptions
): Promise<RunBatchEvaluationCommandResult> {
  const { agent, evaluators, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, onProgress } = options;

  let logger: ExecLogger | undefined;
  try {
    logger = new ExecLogger({ command: 'batch-evaluate' });
  } catch {
    // Non-fatal
  }

  try {
    // 1. Read project config and deployed state
    logger?.startStep('Load project config');
    const configIO = new ConfigIO();
    const [projectSpec, deployedState, awsTargets] = await Promise.all([
      configIO.readProjectSpec(),
      configIO.readDeployedState(),
      configIO.resolveAWSDeploymentTargets(),
    ]);

    const region = await getRegion(options.region);
    const stage = process.env.AGENTCORE_STAGE?.toLowerCase() ?? 'prod';
    logger?.log(`Region: ${region}, Stage: ${stage}`);
    logger?.endStep('success');

    // 2. Resolve agent from deployed state
    logger?.startStep('Resolve agent');
    const agentState = resolveAgentState(deployedState, agent);
    if (!agentState) {
      const error = `Agent "${agent}" not deployed. Run \`agentcore deploy\` first.`;
      logger?.log(error, 'error');
      logger?.endStep('error', error);
      logger?.finalize(false);
      return { success: false, error: new ResourceNotFoundError(error), results: [], logFilePath: logger?.logFilePath };
    }

    const runtimeId = agentState.runtimeId;
    // Service name in CW logs uses project_agent format without the CDK hash suffix
    const endpointName = resolveEndpointName(options.endpoint);
    const serviceName = `${projectSpec.name}_${agent}.${endpointName}`;
    const runtimeLogGroupName = runtimeLogGroup(runtimeId, options.endpoint);

    logger?.log(`Agent: ${agent} (runtime: ${runtimeId})`);
    logger?.log(`Service name: ${serviceName}`);
    logger?.log(`Log group: ${runtimeLogGroupName}`);
    logger?.endStep('success');

    // 2b. Resolve evaluator names to deployed IDs
    // Handles: "Builtin.Correctness", "arn:aws:...:evaluator/Builtin.Correctness", or custom evaluator names
    const targetResources = Object.values(deployedState.targets).find(t => t.resources?.runtimes?.[agent])?.resources;
    const resolvedEvaluators = evaluators.map(name => {
      // Extract short name from ARN if passed (e.g. "arn:aws:bedrock-agentcore:::evaluator/Builtin.Correctness" → "Builtin.Correctness")
      const shortName = name.includes('evaluator/') ? name.split('evaluator/').pop()! : name;
      if (shortName.startsWith('Builtin.')) return shortName;
      const deployed = targetResources?.evaluators?.[shortName];
      if (deployed?.evaluatorId) {
        logger?.log(`Resolved evaluator "${shortName}" → ${deployed.evaluatorId}`);
        return deployed.evaluatorId;
      }
      logger?.log(`Evaluator "${shortName}" not found in deployed state, passing as-is`, 'warn');
      return shortName;
    });

    // 3. Start the batch evaluation
    logger?.startStep('Start batch evaluation');
    let evalName: string;
    if (options.name) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(options.name)) {
        return {
          success: false,
          error: new ValidationError(
            `Batch evaluation name must start with a letter and contain only letters, digits, and underscores (max 48 chars). Got: "${options.name}"`
          ),
          results: [],
          logFilePath: logger?.logFilePath,
        };
      }
      evalName = options.name;
    } else {
      evalName = `${projectSpec.name}_${agent}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
    }

    onProgress?.('starting', `Starting batch evaluation "${evalName}"...`);

    // Dataset mode: invoke agent with scenarios first, then use those sessionIds
    let datasetSessionIds: string[] = [];
    let datasetMetadata: SessionMetadataEntry[] = [];
    if (options.dataset) {
      const agentContext = await resolveAgentContext({
        project: projectSpec,
        deployedState,
        awsTargets,
        agentName: agent,
        endpoint: options.endpoint,
      });

      onProgress?.('invoking', `Invoking agent with dataset "${options.dataset}"...`);

      const datasetResult = await runDatasetScenarios({
        agentContext,
        datasetName: options.dataset,
        version: options.datasetVersion,
        configBaseDir: configIO.getConfigRoot(),
        onProgress: (phase, msg) => onProgress?.(phase, msg),
      });

      const successfulResults = datasetResult.scenarioResults.filter(r => r.status === 'success');
      if (successfulResults.length === 0) {
        return {
          success: false,
          error: new Error('All scenarios failed during invocation. No sessions to evaluate.'),
          results: [],
          logFilePath: logger?.logFilePath,
        };
      }

      datasetSessionIds = successfulResults.map(r => r.sessionId);

      // Build sessionMetadata with ground truth from dataset
      datasetMetadata = successfulResults.map(r => {
        const scenario = datasetResult.scenarios.find(s => s.scenario_id === r.scenarioId);
        return {
          sessionId: r.sessionId,
          testScenarioId: r.scenarioId,
          groundTruth: scenario
            ? {
                inline: {
                  ...(scenario.assertions ? { assertions: scenario.assertions.map(a => ({ text: a })) } : {}),
                  ...(scenario.expected_trajectory
                    ? { expectedTrajectory: { toolNames: scenario.expected_trajectory } }
                    : {}),
                  ...(scenario.turns.some(t => t.expectedResponse)
                    ? {
                        turns: scenario.turns.map(t => ({
                          input: { prompt: t.input },
                          ...(t.expectedResponse ? { expectedResponse: { text: t.expectedResponse } } : {}),
                        })),
                      }
                    : {}),
                },
              }
            : undefined,
        };
      }) as SessionMetadataEntry[];

      onProgress?.('invoking', `✓ ${successfulResults.length} sessions ready for batch evaluation`);

      // Wait for CloudWatch span ingestion before submitting — the batch service
      // queries CloudWatch server-side, so we can't poll. Match SDK default (180s).
      onProgress?.('ingesting', 'Waiting 180s for CloudWatch span ingestion...');
      await sleep(BATCH_INGESTION_DELAY_MS);
    }

    // Build optional filter config for CloudWatch filtering
    // API requires either sessionIds OR timeRange, not both — sessionIds takes precedence
    // Merge explicit sessionIds with any sessionIds from sessionMetadata (deduplicated)
    const metadataSessionIds = options.sessionMetadata?.map(m => m.sessionId).filter(Boolean) ?? [];
    const explicitSessionIds = [...(options.sessionIds ?? []), ...datasetSessionIds];
    const effectiveSessionIds = [...new Set([...explicitSessionIds, ...metadataSessionIds])];
    const hasSessionIds = effectiveSessionIds.length > 0;

    const filterConfig: CloudWatchFilterConfig | undefined = (() => {
      if (hasSessionIds) {
        return { sessionIds: effectiveSessionIds };
      }
      if (options.lookbackDays) {
        const endTime = new Date().toISOString();
        const startTime = new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000).toISOString();
        return { timeRange: { startTime, endTime } };
      }
      return undefined;
    })();

    // Merge dataset metadata with any explicit sessionMetadata
    const allSessionMetadata = [...(options.sessionMetadata ?? []), ...datasetMetadata];

    const startPayload = {
      region,
      name: evalName,
      evaluators: resolvedEvaluators.map(id => ({ evaluatorId: id })),
      dataSourceConfig: {
        cloudWatchLogs: {
          serviceNames: [serviceName],
          logGroupNames: [runtimeLogGroupName],
          ...(filterConfig ? { filterConfig } : {}),
        },
      },
      ...(allSessionMetadata.length > 0 ? { evaluationMetadata: { sessionMetadata: allSessionMetadata } } : {}),
      clientToken: generateClientToken(),
    };

    logger?.log(`Request payload:\n${JSON.stringify(startPayload, null, 2)}`);

    const startResult = await startBatchEvaluation(startPayload);

    logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
    logger?.endStep('success');

    onProgress?.('running', `Batch evaluation started (ID: ${startResult.batchEvaluationId})`);
    onProgress?.('running', 'This may take a few minutes...');
    options.onStarted?.({ batchEvaluationId: startResult.batchEvaluationId, region });

    // 4. Poll for completion
    logger?.startStep('Poll for completion');
    let current: GetBatchEvaluationResult = {
      batchEvaluationId: startResult.batchEvaluationId,
      batchEvaluationArn: startResult.batchEvaluationArn,
      name: startResult.name,
      status: startResult.status,
    };

    while (!TERMINAL_STATUSES.has(current.status)) {
      await sleep(pollIntervalMs);

      current = await getBatchEvaluation({
        region,
        batchEvaluationId: startResult.batchEvaluationId,
      });

      onProgress?.('polling', `Status: ${current.status}`);
      logger?.log(`Poll status: ${current.status}`);
    }

    if (current.status !== 'COMPLETED' && current.status !== 'COMPLETED_WITH_ERRORS') {
      const reasons = current.errorDetails?.join('; ') ?? '';
      const error = `Batch evaluation finished with status: ${current.status}${reasons ? ` — ${reasons}` : ''}`;
      logger?.log(error, 'error');
      logger?.log(`Full poll response:\n${JSON.stringify(current, null, 2)}`, 'error');
      logger?.endStep('error', error);
      logger?.finalize(false);
      return {
        success: false,
        error: new Error(error),
        batchEvaluationId: startResult.batchEvaluationId,
        name: evalName,
        status: current.status,
        results: [],
        logFilePath: logger?.logFilePath,
      };
    }

    logger?.endStep('success');

    // 5. Fetch results from CloudWatch output logs
    logger?.startStep('Fetch results');
    let results: BatchEvaluationResult[] = [];

    const cwDest = current.outputConfig?.cloudWatchConfig;
    if (cwDest) {
      try {
        results = await fetchResultsFromCloudWatch(region, cwDest.logGroupName, cwDest.logStreamName);
        logger?.log(`Fetched ${results.length} result(s) from CloudWatch`);
      } catch (cwErr: unknown) {
        logger?.log(`Failed to fetch CW results: ${cwErr instanceof Error ? cwErr.message : String(cwErr)}`, 'error');
      }
    }

    logger?.endStep('success');

    logger?.log(`Results: ${JSON.stringify(results, null, 2)}`);
    logger?.finalize(true);

    return {
      success: true,
      batchEvaluationId: startResult.batchEvaluationId,
      name: evalName,
      status: current.status,
      results,
      evaluationResults: current.evaluationResults,
      startedAt: current.createdAt,
      completedAt: current.updatedAt ?? new Date().toISOString(),
      logFilePath: logger?.logFilePath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.log(error, 'error');
    logger?.finalize(false);
    return { success: false, error: toError(err), results: [], logFilePath: logger?.logFilePath };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function resolveAgentState(
  deployedState: DeployedState,
  agentName: string
): { runtimeId: string; runtimeArn: string; roleArn?: string } | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const agent = target.resources?.runtimes?.[agentName];
    if (agent) return agent;
  }
  return undefined;
}

async function fetchResultsFromCloudWatch(
  region: string,
  logGroupName: string,
  logStreamName: string
): Promise<BatchEvaluationResult[]> {
  const client = new CloudWatchLogsClient({ region });
  const response = await client.send(
    new GetLogEventsCommand({
      logGroupName,
      logStreamName,
      startFromHead: true,
    })
  );

  const results: BatchEvaluationResult[] = [];
  for (const event of response.events ?? []) {
    if (!event.message) continue;
    try {
      const parsed = JSON.parse(event.message) as Record<string, unknown>;
      const attrs = (parsed.attributes ?? {}) as Record<string, unknown>;
      const evaluatorId = attrs['gen_ai.evaluation.name'] as string | undefined;
      if (!evaluatorId) continue;

      results.push({
        evaluatorId,
        score: attrs['gen_ai.evaluation.score.value'] as number | undefined,
        label: attrs['gen_ai.evaluation.score.label'] as string | undefined,
        explanation: attrs['gen_ai.evaluation.explanation'] as string | undefined,
      });
    } catch {
      // Skip non-JSON or malformed entries
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
