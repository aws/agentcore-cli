/**
 * Insights job handler — composes Startable, Refreshable, Archivable.
 *
 *  - create():  resolve agent, build dataSourceConfig (cloudWatchLogs or onlineEvaluationConfigSource),
 *               send `insights` field (optionally with evaluators for recommendation chaining),
 *               call startBatchEvaluation, persist the record.
 *  - refresh(): GET latest status; map 404 -> NOT_FOUND. Parse failureAnalysisResult from response.
 *  - archive(): DeleteBatchEvaluation.
 *
 * Insights jobs are NOT stoppable.
 */
import { ConfigIO, JobNotFoundError, ResourceNotFoundError, ValidationError, toError } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import {
  deleteBatchEvaluation,
  generateClientToken,
  getBatchEvaluation,
  startBatchEvaluation,
} from '../../../aws/agentcore-batch-evaluation';
import type { CloudWatchFilterConfig, DataSourceConfig } from '../../../aws/agentcore-batch-evaluation';
import { resolveEndpointName, runtimeLogGroup } from '../../../aws/cloudwatch';
import { detectRegion } from '../../../aws/region';
import { ExecLogger } from '../../../logging/exec-logger';
import { resolveBatchEvaluatorIds } from '../batch-evaluation/build-source';
import { NOT_FOUND_STATUS } from '../shared/constants';
import { regionFromArn, resolveJobRegion } from '../shared/region';
import { resolveAgentState } from '../shared/resolve-agent-state';
import type { InsightsHandler, InsightsJobRecord, StartInsightsJobOptions } from '../shared/types';

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

/** Auto-generate a job name from project/agent/timestamp, validating user-provided names. */
function resolveInsightsName(name: string | undefined, projectName: string, agent: string): string {
  if (name) {
    if (!NAME_PATTERN.test(name)) {
      throw new ValidationError(
        `Job name "${name}" is invalid. Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars).`
      );
    }
    return name;
  }
  return `${projectName}_${agent}_insights_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
}

/** Build the CloudWatch filter config for session/time filtering. */
function buildFilterConfig(
  sessionIds: string[] | undefined,
  lookbackDays: number | undefined,
  startTime: string | undefined,
  endTime: string | undefined
): CloudWatchFilterConfig | undefined {
  const effective = [...new Set(sessionIds ?? [])];
  if (effective.length > 0) {
    return { sessionIds: effective };
  }
  if (startTime || endTime) {
    return { timeRange: { startTime, endTime } };
  }
  if (lookbackDays !== undefined) {
    validateLookbackDays(lookbackDays);
    const end = new Date().toISOString();
    const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    return { timeRange: { startTime: start, endTime: end } };
  }
  return undefined;
}

export const insightsHandler: InsightsHandler = {
  async create(opts: StartInsightsJobOptions, configIO: ConfigIO): Promise<Result<{ record: InsightsJobRecord }>> {
    let logger: ExecLogger | undefined;
    try {
      logger = new ExecLogger({ command: 'insights' });
    } catch {
      // non-fatal
    }

    try {
      logger?.startStep('Load project config');
      const [projectSpec, deployedState, awsTargets] = await Promise.all([
        configIO.readProjectSpec(),
        configIO.readDeployedState(),
        configIO.resolveAWSDeploymentTargets(),
      ]);
      const region = await resolveJobRegion(opts.region, awsTargets);
      logger?.endStep('success');

      // Determine agent name — required unless using onlineEvalConfigArn
      const agentName = opts.agent ?? projectSpec.runtimes?.[0]?.name ?? '';

      let dataSourceConfig: DataSourceConfig;

      if (opts.onlineEvalConfigArn) {
        // Use existing online evaluation config as the session source
        logger?.startStep('Use online eval config source');
        dataSourceConfig = {
          onlineEvaluationConfigSource: { onlineEvaluationConfigArn: opts.onlineEvalConfigArn },
        };
        logger?.endStep('success');
      } else {
        // Build CloudWatch logs source
        logger?.startStep('Resolve agent');
        const agentState = resolveAgentState(deployedState, agentName);
        if (!agentState) {
          const err = new ResourceNotFoundError(`Agent "${agentName}" not deployed. Run \`agentcore deploy\` first.`);
          logger?.endStep('error', err.message);
          logger?.finalize(false);
          return { success: false, error: err };
        }

        const endpointName = resolveEndpointName(opts.endpoint);
        const serviceName = `${projectSpec.name}_${agentName}.${endpointName}`;
        const logGroupName = runtimeLogGroup(agentState.runtimeId, opts.endpoint);
        logger?.log(`Service name: ${serviceName}`);
        logger?.log(`Log group: ${logGroupName}`);
        logger?.endStep('success');

        const filterConfig = buildFilterConfig(opts.sessionIds, opts.lookbackDays, opts.startTime, opts.endTime);
        dataSourceConfig = {
          cloudWatchLogs: {
            serviceNames: [serviceName],
            logGroupNames: [logGroupName],
            ...(filterConfig ? { filterConfig } : {}),
          },
        };
      }

      const evalName = resolveInsightsName(opts.name, projectSpec.name, agentName);

      // Resolve evaluators if provided (for recommendation chaining)
      const resolvedEvaluators = opts.evaluators?.length
        ? resolveBatchEvaluatorIds(deployedState, agentName, opts.evaluators)
        : undefined;

      logger?.startStep('Start insights job');
      opts.onProgress?.('starting', `Starting insights job "${evalName}"...`);
      const startResult = await startBatchEvaluation({
        region,
        name: evalName,
        ...(!opts.onlineEvalConfigArn && { insights: opts.insights.map(id => ({ insightId: id })) }),
        ...(!opts.onlineEvalConfigArn && resolvedEvaluators && resolvedEvaluators.length > 0
          ? { evaluators: resolvedEvaluators.map(id => ({ evaluatorId: id })) }
          : {}),
        dataSourceConfig,
        clientToken: generateClientToken(),
      });
      logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
      logger?.endStep('success');
      opts.onProgress?.('started', `Insights job created: ${startResult.batchEvaluationId} (${startResult.status})`);
      logger?.finalize(true);

      const record: InsightsJobRecord = {
        type: 'insights',
        id: startResult.batchEvaluationId,
        arn: startResult.batchEvaluationArn,
        status: startResult.status,
        createdAt: startResult.createdAt ?? new Date().toISOString(),
        agent: agentName,
        logFilePath: logger?.logFilePath,
        name: evalName,
        insights: opts.insights,
        evaluators: resolvedEvaluators,
      };
      return { success: true, record };
    } catch (err) {
      logger?.finalize(false);
      return { success: false, error: toError(err) };
    }
  },

  async refresh(record: InsightsJobRecord): Promise<Result<{ record: InsightsJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    let response;
    try {
      response = await getBatchEvaluation({ region, batchEvaluationId: record.id });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true, record: { ...record, status: NOT_FOUND_STATUS } };
      }
      return { success: false, error: toError(err) };
    }

    const updated: InsightsJobRecord = {
      ...record,
      status: response.status,
      completedAt: response.updatedAt ?? record.completedAt,
      evaluationResults: response.evaluationResults ?? record.evaluationResults,
      failureAnalysisResult: response.failureAnalysisResult ?? record.failureAnalysisResult,
    };

    return { success: true, record: updated };
  },

  async archive(record: InsightsJobRecord): Promise<Result> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await deleteBatchEvaluation({ region, batchEvaluationId: record.id });
      return { success: true };
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true };
      }
      return { success: false, error: toError(err) };
    }
  },
};

/** Validates that lookbackDays is a positive integer. */
export function validateLookbackDays(lookbackDays: number): void {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new ValidationError('--lookback-days must be a positive integer (at least 1).');
  }
}
