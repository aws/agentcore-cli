/**
 * Batch-evaluation job handler — composes Startable, Refreshable, Stoppable, Archivable.
 *
 *  - create():  resolve agent + evaluators (short ids), build dataSourceConfig (serviceName/logGroup +
 *               sessionIds|timeRange filter), attach ground-truth metadata, make ONE StartBatchEvaluation
 *               call, persist the record. Dataset Phase-1 (invoke scenarios + ingestion wait) is the
 *               caller's responsibility — it supplies sessionIds/sessionMetadata.
 *  - refresh(): GET latest status; map 404 → NOT_FOUND. On terminal status, fetch per-session scores
 *               from the CloudWatch output log once (resultsFetched guards + enables retry).
 *  - stop():    StopBatchEvaluation.
 *  - archive(): DeleteBatchEvaluation.
 */
import { ConfigIO, JobNotFoundError, ResourceNotFoundError, toError } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import {
  deleteBatchEvaluation,
  generateClientToken,
  getBatchEvaluation,
  startBatchEvaluation,
  stopBatchEvaluation,
} from '../../../aws/agentcore-batch-evaluation';
import type { BatchEvaluationResultEntry } from '../../../aws/agentcore-batch-evaluation';
import { detectRegion } from '../../../aws/region';
import { ExecLogger } from '../../../logging/exec-logger';
import { NOT_FOUND_STATUS } from '../shared/constants';
import { regionFromArn, resolveJobRegion } from '../shared/region';
import { resolveAgentState } from '../shared/resolve-agent-state';
import type { BatchEvaluationHandler, BatchEvaluationJobRecord, StartBatchEvaluationJobOptions } from '../shared/types';
import {
  buildCloudWatchFilterConfig,
  buildCloudWatchSource,
  resolveBatchEvalName,
  resolveBatchEvaluatorIds,
} from './build-source';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

/** Read per-session evaluation scores from the batch's CloudWatch output log stream. */
async function fetchResultsFromCloudWatch(
  region: string,
  logGroupName: string,
  logStreamName: string
): Promise<BatchEvaluationResultEntry[]> {
  const client = new CloudWatchLogsClient({ region });
  const response = await client.send(new GetLogEventsCommand({ logGroupName, logStreamName, startFromHead: true }));

  const results: BatchEvaluationResultEntry[] = [];
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
      // skip non-JSON / malformed entries
    }
  }
  return results;
}

export const batchEvaluationHandler: BatchEvaluationHandler = {
  async create(
    opts: StartBatchEvaluationJobOptions,
    configIO: ConfigIO
  ): Promise<Result<{ record: BatchEvaluationJobRecord }>> {
    let logger: ExecLogger | undefined;
    try {
      logger = new ExecLogger({ command: 'batch-evaluate' });
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

      logger?.startStep('Resolve agent');
      const agentState = resolveAgentState(deployedState, opts.agent);
      if (!agentState) {
        const err = new ResourceNotFoundError(`Agent "${opts.agent}" not deployed. Run \`agentcore deploy\` first.`);
        logger?.endStep('error', err.message);
        logger?.finalize(false);
        return { success: false, error: err };
      }
      const { serviceName, logGroupName } = buildCloudWatchSource(
        projectSpec.name,
        opts.agent,
        agentState.runtimeId,
        opts.endpoint
      );
      logger?.log(`Service name: ${serviceName}`);
      logger?.log(`Log group: ${logGroupName}`);
      logger?.endStep('success');

      // Resolve name + evaluators (ValidationError on a bad explicit name)
      const evalName = resolveBatchEvalName(opts.name, projectSpec.name, opts.agent);
      const resolvedEvaluators = resolveBatchEvaluatorIds(deployedState, opts.agent, opts.evaluators);

      // CloudWatch filter — merge explicit sessionIds with any from sessionMetadata, dedup
      const metadataSessionIds = opts.sessionMetadata?.map(m => m.sessionId).filter(Boolean) ?? [];
      const effectiveSessionIds = [...new Set([...(opts.sessionIds ?? []), ...metadataSessionIds])];
      const filterConfig = buildCloudWatchFilterConfig(effectiveSessionIds, opts.lookbackDays);

      logger?.startStep('Start batch evaluation');
      opts.onProgress?.('starting', `Starting batch evaluation "${evalName}"...`);
      const startResult = await startBatchEvaluation({
        region,
        name: evalName,
        evaluators: resolvedEvaluators.map(id => ({ evaluatorId: id })),
        dataSourceConfig: {
          cloudWatchLogs: {
            serviceNames: [serviceName],
            logGroupNames: [logGroupName],
            ...(filterConfig ? { filterConfig } : {}),
          },
        },
        ...(opts.sessionMetadata && opts.sessionMetadata.length > 0
          ? { evaluationMetadata: { sessionMetadata: opts.sessionMetadata } }
          : {}),
        ...(opts.kmsKeyArn ? { kmsKeyArn: opts.kmsKeyArn } : {}),
        clientToken: generateClientToken(),
      });
      logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
      logger?.endStep('success');
      opts.onProgress?.(
        'started',
        `Batch evaluation created: ${startResult.batchEvaluationId} (${startResult.status})`
      );
      logger?.finalize(true);

      const record: BatchEvaluationJobRecord = {
        type: 'batch-evaluation',
        id: startResult.batchEvaluationId,
        arn: startResult.batchEvaluationArn,
        status: startResult.status,
        createdAt: startResult.createdAt ?? new Date().toISOString(),
        agent: opts.agent,
        logFilePath: logger?.logFilePath,
        name: evalName,
        evaluators: resolvedEvaluators,
        source: opts.source,
        dataset: opts.dataset,
        ...(opts.kmsKeyArn ? { kmsKeyArn: opts.kmsKeyArn } : {}),
      };
      return { success: true, record };
    } catch (err) {
      logger?.finalize(false);
      return { success: false, error: toError(err) };
    }
  },

  async refresh(record: BatchEvaluationJobRecord): Promise<Result<{ record: BatchEvaluationJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    let response;
    try {
      response = await getBatchEvaluation({ region, batchEvaluationId: record.id });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true, record: { ...record, status: NOT_FOUND_STATUS, resultsFetched: true } };
      }
      return { success: false, error: toError(err) };
    }

    const updated: BatchEvaluationJobRecord = {
      ...record,
      status: response.status,
      completedAt: response.updatedAt ?? record.completedAt,
      evaluationResults: response.evaluationResults ?? record.evaluationResults,
      kmsKeyArn: response.kmsKeyArn ?? record.kmsKeyArn,
    };

    // Fetch per-session scores from the CloudWatch output log once the job is terminal.
    const isTerminalStatus = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'STOPPED', 'CANCELLED'].includes(
      response.status
    );
    const cw = response.outputConfig?.cloudWatchConfig;
    if (isTerminalStatus && !record.resultsFetched && cw) {
      try {
        const results = await fetchResultsFromCloudWatch(region, cw.logGroupName, cw.logStreamName);
        // Never clobber populated results with an empty re-read.
        if (results.length > 0 || !record.results?.length) {
          updated.results = results;
        }
        updated.resultsFetched = true;
      } catch {
        // leave resultsFetched false so the next get()/list() retries
      }
    } else if (isTerminalStatus && !cw) {
      // Terminal with no output log destination — nothing to fetch; mark settled.
      updated.resultsFetched = true;
    }
    return { success: true, record: updated };
  },

  async stop(record: BatchEvaluationJobRecord): Promise<Result> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await stopBatchEvaluation({ region, batchEvaluationId: record.id });
      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  },

  async archive(record: BatchEvaluationJobRecord): Promise<Result> {
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
