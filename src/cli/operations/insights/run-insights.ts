/**
 * Orchestrates running an Insights job:
 *   1. Resolve agent from deployed state (for serviceNames / logGroupNames)
 *   2. Build insights + dataSourceConfig
 *   3. Call StartBatchEvaluation
 *   4. Optionally poll GetBatchEvaluation until terminal status
 *   5. Return results
 */
import { ConfigIO, ResourceNotFoundError, toError } from '../../../lib';
import type { DeployedState } from '../../../schema';
import type { CloudWatchFilterConfig, InsightConfig } from '../../aws/agentcore-batch-evaluation';
import { generateClientToken, getBatchEvaluation, startBatchEvaluation } from '../../aws/agentcore-batch-evaluation';
import { resolveEndpointName, runtimeLogGroup } from '../../aws/cloudwatch';
import { getRegion } from '../../commands/shared/region-utils';
import { ExecLogger } from '../../logging/exec-logger';
import { saveInsightsRun, updateInsightsRun } from './insights-storage';
import type { InsightsRunRecord, RunInsightsOptions, RunInsightsResult } from './types';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'COMPLETED_WITH_ERRORS', 'STOPPED', 'CANCELLED']);

// ============================================================================
// Implementation
// ============================================================================

export async function runInsightsCommand(options: RunInsightsOptions): Promise<RunInsightsResult> {
  let logger: ExecLogger | undefined;
  try {
    logger = new ExecLogger({ command: 'insights' });
  } catch {
    // Non-fatal
  }

  try {
    // 1. Load project config + deployed state
    logger?.startStep('Load project config');
    const configIO = new ConfigIO();
    const [projectSpec, deployedState] = await Promise.all([configIO.readProjectSpec(), configIO.readDeployedState()]);

    const region = await getRegion(options.region);
    logger?.log(`Region: ${region}`);
    logger?.endStep('success');

    // 2. Build dataSourceConfig
    logger?.startStep('Build data source config');
    let dataSourceConfig: {
      cloudWatchLogs?: {
        serviceNames: string[];
        logGroupNames: string[];
        filterConfig?: CloudWatchFilterConfig;
      };
      onlineEvaluationConfigSource?: { onlineEvaluationConfigArn: string };
    };

    if (options.onlineEvalConfigArn) {
      // Online evaluation config source mode
      dataSourceConfig = {
        onlineEvaluationConfigSource: { onlineEvaluationConfigArn: options.onlineEvalConfigArn },
      };
      logger?.log(`Using onlineEvaluationConfigSource: ${options.onlineEvalConfigArn}`);
    } else {
      // CloudWatch logs mode — requires agent
      if (!options.agent) {
        const error = 'Agent name is required when not using --online-eval-config-arn';
        logger?.log(error, 'error');
        logger?.endStep('error', error);
        logger?.finalize(false);
        return { success: false, error: new ResourceNotFoundError(error), logFilePath: logger?.logFilePath };
      }

      const agentState = resolveAgentState(deployedState, options.agent);
      if (!agentState) {
        const error = `Agent "${options.agent}" not deployed. Run \`agentcore deploy\` first.`;
        logger?.log(error, 'error');
        logger?.endStep('error', error);
        logger?.finalize(false);
        return { success: false, error: new ResourceNotFoundError(error), logFilePath: logger?.logFilePath };
      }

      const runtimeId = agentState.runtimeId;
      const endpointName = resolveEndpointName(options.endpoint);
      const serviceName = `${projectSpec.name}_${options.agent}.${endpointName}`;
      const logGroupName = runtimeLogGroup(runtimeId, options.endpoint);

      logger?.log(`Agent: ${options.agent} (runtime: ${runtimeId})`);
      logger?.log(`Service name: ${serviceName}`);
      logger?.log(`Log group: ${logGroupName}`);

      // Build filterConfig from lookbackDays/startTime/endTime/sessionIds
      const filterConfig = buildFilterConfig(options);

      dataSourceConfig = {
        cloudWatchLogs: {
          serviceNames: [serviceName],
          logGroupNames: [logGroupName],
          ...(filterConfig ? { filterConfig } : {}),
        },
      };
    }
    logger?.endStep('success');

    // 3. Build insights array
    const insights: InsightConfig[] = options.insights.map(id => ({ insightId: id }));

    // 4. Generate name if not provided
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).slice(2, 8);
    const name = options.name ?? `${options.agent ?? 'insights'}_insights_${dateStr}_${rand}`;

    // 5. Call startBatchEvaluation
    logger?.startStep('Start insights job');
    options.onProgress?.('starting', `Starting insights job "${name}"...`);

    const evaluators = options.evaluators?.map(id => ({ evaluatorId: id }));

    const startPayload = {
      region,
      name,
      insights,
      ...(evaluators?.length && { evaluators }),
      dataSourceConfig,
      clientToken: generateClientToken(),
    };

    logger?.log(`Request payload:\n${JSON.stringify(startPayload, null, 2)}`);
    const startResult = await startBatchEvaluation(startPayload);
    logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
    logger?.endStep('success');

    options.onProgress?.('running', `Insights job started (ID: ${startResult.batchEvaluationId})`);
    options.onStarted?.({ batchEvaluationId: startResult.batchEvaluationId, region });

    // 6. Save initial record
    const record: InsightsRunRecord = {
      batchEvaluationId: startResult.batchEvaluationId,
      batchEvaluationArn: startResult.batchEvaluationArn,
      name: startResult.name,
      status: startResult.status,
      region,
      createdAt: startResult.createdAt,
      insights: options.insights,
      agent: options.agent,
    };
    saveInsightsRun(record);

    // 7. If wait mode — poll until terminal
    if (options.wait) {
      logger?.startStep('Poll for completion');
      const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      while (!TERMINAL_STATUSES.has(record.status)) {
        await sleep(pollInterval);

        const current = await getBatchEvaluation({
          region,
          batchEvaluationId: startResult.batchEvaluationId,
        });

        record.status = current.status;
        if (current.evaluationResults) {
          record.sessionCount = current.evaluationResults.totalNumberOfSessions;
          record.sessionsCompleted = current.evaluationResults.numberOfSessionsCompleted;
          record.sessionsFailed = current.evaluationResults.numberOfSessionsFailed;
        }
        if (TERMINAL_STATUSES.has(current.status)) {
          record.completedAt = current.updatedAt;
        }
        updateInsightsRun(startResult.batchEvaluationId, record);
        options.onProgress?.(current.status, `Status: ${current.status}`);
        logger?.log(`Poll status: ${current.status}`);
      }
      logger?.endStep('success');
    }

    logger?.finalize(true);

    // 8. Return result
    return {
      success: true,
      batchEvaluationId: record.batchEvaluationId,
      batchEvaluationArn: record.batchEvaluationArn,
      name: record.name,
      status: record.status,
      region,
      sessionCount: record.sessionCount,
      sessionsCompleted: record.sessionsCompleted,
      sessionsFailed: record.sessionsFailed,
      logFilePath: logger?.logFilePath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger?.log(error, 'error');
    logger?.finalize(false);
    return { success: false, error: toError(err), logFilePath: logger?.logFilePath };
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

function buildFilterConfig(options: RunInsightsOptions): CloudWatchFilterConfig | undefined {
  if (options.sessionIds && options.sessionIds.length > 0) {
    return { sessionIds: options.sessionIds };
  }
  // Use explicit startTime/endTime if provided, otherwise fall back to lookbackDays
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const endTime = options.endTime ?? new Date().toISOString();
  const startTime = options.startTime ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  return { timeRange: { startTime, endTime } };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
