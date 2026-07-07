/**
 * Recommendation job handler — composes Startable, Refreshable, Settles, Archivable.
 *
 *  - create():  resolve agent + evaluator(s), build the recommendationConfig (incl. the slow
 *               sessions/spans-file fetch), make ONE StartRecommendation call, persist the record.
 *  - refresh(): GET latest status; map 404 → NOT_FOUND; copy result / failure detail. Pure (no config writes).
 *  - settle():  once COMPLETED for a config-bundle input, sync the new bundle version into agentcore.json
 *               exactly once (idempotent via syncedVersionId). Runs sequentially in the engine.
 *  - archive(): DeleteRecommendation (recommendation has no Stop — archive is the cancel).
 */
import { ConfigIO, JobNotFoundError, ResourceNotFoundError, ValidationError, toError } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import { deleteRecommendation, getRecommendation, startRecommendation } from '../../../aws/agentcore-recommendation';
import { detectRegion } from '../../../aws/region';
import { ExecLogger } from '../../../logging/exec-logger';
import {
  MAX_INLINE_TEXT_LENGTH,
  NOT_FOUND_STATUS,
  RECOMMENDATION_NAME_REGEX,
  TERMINAL_STATUSES,
} from '../shared/constants';
import { regionFromArn, resolveJobRegion } from '../shared/region';
import { resolveAgentState } from '../shared/resolve-agent-state';
import type { RecommendationHandler, RecommendationJobRecord, StartRecommendationJobOptions } from '../shared/types';
import { applyRecommendationToBundle } from './apply-to-bundle';
import {
  buildRecommendationConfig,
  extractAccountIdFromArn,
  extractFailureDetails,
  resolveBundleVersionId,
  resolveComponentKeyForJsonPath,
  resolveEvaluatorId,
} from './build-config';
import { readFileSync } from 'fs';

/** Max length the service allows for a recommendation name (RECOMMENDATION_NAME_REGEX: 48 chars). */
const MAX_RECOMMENDATION_NAME_LENGTH = 48;

/**
 * Build an auto-generated recommendation name that satisfies the service constraint
 * (RECOMMENDATION_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/). The `<project>_<agent>` prefix is
 * sanitized (invalid chars → `_`) and truncated so that `<prefix>_<timestamp>` stays within 48
 * chars; the full timestamp is kept as the suffix to preserve uniqueness across runs.
 */
export function autoRecommendationName(
  projectName: string,
  agent: string | undefined,
  now: number = Date.now()
): string {
  const suffix = String(now);
  const maxPrefix = MAX_RECOMMENDATION_NAME_LENGTH - suffix.length - 1; // 1 for the joining "_"
  const rawPrefix = agent ? `${projectName}_${agent}` : projectName;
  let prefix = rawPrefix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, Math.max(1, maxPrefix));
  // Must begin with a letter; if truncation/sanitization left a non-letter lead, prefix with 'r'.
  if (!/^[a-zA-Z]/.test(prefix)) prefix = `r${prefix}`.slice(0, Math.max(1, maxPrefix));
  return `${prefix}_${suffix}`;
}

export const recommendationHandler: RecommendationHandler = {
  async create(
    opts: StartRecommendationJobOptions,
    configIO: ConfigIO
  ): Promise<Result<{ record: RecommendationJobRecord }>> {
    let logger: ExecLogger | undefined;
    try {
      logger = new ExecLogger({ command: 'recommend' });
    } catch {
      // Logger creation can fail in tests or with no project root — non-fatal.
    }

    try {
      logger?.startStep('Load project config');
      const [projectSpec, deployedState, awsTargets] = await Promise.all([
        configIO.readProjectSpec(),
        configIO.readDeployedState(),
        configIO.resolveAWSDeploymentTargets(),
      ]);
      const region = await resolveJobRegion(opts.region, awsTargets);
      logger?.log(`Region: ${region}`);
      logger?.endStep('success');

      // Resolve agent (needed for runtimeId + account id from its ARN) — skip for batch-evaluation source
      logger?.startStep('Resolve agent and evaluators');
      const agentState = opts.agent ? resolveAgentState(deployedState, opts.agent) : undefined;
      if (!agentState && opts.traceSource !== 'batch-evaluation') {
        const err = new ResourceNotFoundError(`Agent "${opts.agent}" not deployed. Run \`agentcore deploy\` first.`);
        logger?.endStep('error', err.message);
        logger?.finalize(false);
        return { success: false, error: err };
      }

      // Resolve evaluators (arity enforced here, not at the command layer)
      const evaluatorIds: string[] = [];
      for (const evaluator of opts.evaluators) {
        const id = resolveEvaluatorId(deployedState, evaluator, region);
        if (!id) {
          const err = new ResourceNotFoundError(
            `Evaluator "${evaluator}" not found. Use a Builtin.* name, a full ARN, or deploy a custom evaluator first.`
          );
          logger?.endStep('error', err.message);
          logger?.finalize(false);
          return { success: false, error: err };
        }
        evaluatorIds.push(id);
      }
      if (opts.type === 'SYSTEM_PROMPT_RECOMMENDATION' && evaluatorIds.length !== 1) {
        const err = new ValidationError('System prompt recommendations require exactly one evaluator.');
        logger?.endStep('error', err.message);
        logger?.finalize(false);
        return { success: false, error: err };
      }
      logger?.log(`Evaluators: ${evaluatorIds.join(', ') || '(none)'}`);
      logger?.endStep('success');

      // Read inline/file content + validate non-empty system-prompt before any API call
      let inlineContent: string | undefined;
      if (opts.inputSource === 'file' && opts.promptFile) {
        inlineContent = readFileSync(opts.promptFile, 'utf-8');
      } else if (opts.inputSource === 'inline') {
        inlineContent = opts.inlineContent;
      }
      if (
        opts.type === 'SYSTEM_PROMPT_RECOMMENDATION' &&
        opts.inputSource !== 'config-bundle' &&
        !inlineContent?.trim()
      ) {
        const err = new ValidationError(
          'System prompt content is required. Provide via --inline, --prompt-file, or --bundle-name.'
        );
        logger?.finalize(false);
        return { success: false, error: err };
      }
      if (inlineContent && inlineContent.length > MAX_INLINE_TEXT_LENGTH) {
        const err = new ValidationError(
          `Inline text exceeds the maximum allowed length (${inlineContent.length} characters, limit is ${MAX_INLINE_TEXT_LENGTH}).`
        );
        logger?.finalize(false);
        return { success: false, error: err };
      }

      const accountId = agentState ? extractAccountIdFromArn(agentState.runtimeArn) : '';

      // Resolve config-bundle ARN + short JSONPath (from deployed state / agentcore.json)
      let bundleArn: string | undefined;
      let resolvedBundleVersion = opts.bundleVersion;
      let resolvedSystemPromptJsonPath = opts.systemPromptJsonPath;
      if (opts.inputSource === 'config-bundle' && opts.bundleName) {
        if (opts.bundleName.startsWith('arn:')) {
          bundleArn = opts.bundleName;
        } else {
          for (const target of Object.values(deployedState.targets ?? {})) {
            const bundle = target?.resources?.configBundles?.[opts.bundleName];
            if (bundle?.bundleArn) {
              bundleArn = bundle.bundleArn;
              break;
            }
          }
          if (!bundleArn) {
            const err = new ResourceNotFoundError(
              `Config bundle "${opts.bundleName}" not found in deployed state. Run \`agentcore deploy\` first.`
            );
            logger?.finalize(false);
            return { success: false, error: err };
          }
        }

        // Expand '--bundle-version LATEST' to the deployed versionId. The recommendation API only
        // accepts a concrete version UUID, so passing 'LATEST' through verbatim yields a 400. (The
        // ab-test path resolves LATEST the same way; this mirrors it.)
        if (resolvedBundleVersion === 'LATEST' && bundleArn) {
          const versionId = resolveBundleVersionId(bundleArn, resolvedBundleVersion, deployedState);
          if (!versionId) {
            const err = new ResourceNotFoundError(
              `Could not resolve version "LATEST" for config bundle "${opts.bundleName}". ` +
                'Run `agentcore deploy` first, or pass an explicit version UUID.'
            );
            logger?.finalize(false);
            return { success: false, error: err };
          }
          resolvedBundleVersion = versionId;
        }

        if (resolvedSystemPromptJsonPath && !resolvedSystemPromptJsonPath.startsWith('$')) {
          const bundleName = opts.bundleName.startsWith('arn:')
            ? Object.values(deployedState.targets)
                .flatMap(t => Object.entries(t.resources?.configBundles ?? {}))
                .find(([, b]) => b.bundleArn === opts.bundleName)?.[0]
            : opts.bundleName;
          if (bundleName) {
            const projBundle = projectSpec.configBundles?.find(b => b.name === bundleName);
            if (projBundle?.components) {
              const firstComponentKey = Object.keys(projBundle.components)[0];
              if (firstComponentKey) {
                const resolvedKey = resolveComponentKeyForJsonPath(firstComponentKey, deployedState);
                resolvedSystemPromptJsonPath = `$.${resolvedKey}.configuration.${resolvedSystemPromptJsonPath}`;
              }
            }
          }
        }
      }

      // Build the request body (this performs the sessions/spans-file fetch when applicable)
      const recommendationConfig = await buildRecommendationConfig({
        type: opts.type,
        inlineContent,
        bundleArn,
        bundleVersion: resolvedBundleVersion,
        systemPromptJsonPath: resolvedSystemPromptJsonPath,
        toolDescJsonPaths: opts.toolDescJsonPaths,
        inputSource: opts.inputSource,
        tools: opts.tools,
        traceSource: opts.traceSource,
        lookbackDays: opts.lookbackDays,
        sessionIds: opts.sessionIds,
        spansFile: opts.spansFile,
        fromInsights: opts.fromInsights,
        batchEvaluationArn: opts.batchEvaluationArn,
        runtimeId: agentState?.runtimeId ?? '',
        accountId,
        region,
        evaluatorIds,
        onProgress: opts.onProgress,
        logger,
      });

      // ONE API call
      logger?.startStep('Start recommendation');
      const name = opts.recommendationName ?? autoRecommendationName(projectSpec.name, opts.agent);
      if (opts.recommendationName && !RECOMMENDATION_NAME_REGEX.test(opts.recommendationName)) {
        const err = new ValidationError(
          `Recommendation name "${opts.recommendationName}" is invalid. Must begin with a letter and contain only alphanumeric characters, underscores, or hyphens (max 48 chars).`
        );
        logger?.endStep('error', err.message);
        logger?.finalize(false);
        return { success: false, error: err };
      }
      opts.onProgress?.('starting', `Starting recommendation "${name}"...`);
      const startResult = await startRecommendation({
        region,
        name,
        type: opts.type,
        recommendationConfig,
        ...(opts.kmsKeyArn ? { kmsKeyArn: opts.kmsKeyArn } : {}),
      });
      logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
      logger?.endStep('success');
      opts.onProgress?.('started', `Recommendation created: ${startResult.recommendationId} (${startResult.status})`);
      logger?.finalize(true);

      const record: RecommendationJobRecord = {
        type: 'recommendation',
        id: startResult.recommendationId,
        arn: startResult.recommendationArn,
        status: startResult.status,
        createdAt: startResult.createdAt ?? new Date().toISOString(),
        agent: opts.agent ?? '',
        logFilePath: logger?.logFilePath,
        recommendationType: opts.type,
        evaluators: opts.evaluators,
        inputSource: opts.inputSource,
        bundleName: opts.bundleName,
        bundleArn,
        bundleVersion: resolvedBundleVersion,
        systemPromptJsonPath: resolvedSystemPromptJsonPath,
        toolDescJsonPaths: opts.toolDescJsonPaths,
        ...(opts.kmsKeyArn ? { kmsKeyArn: opts.kmsKeyArn } : {}),
      };
      return { success: true, record };
    } catch (err) {
      logger?.finalize(false);
      return { success: false, error: toError(err) };
    }
  },

  async refresh(record: RecommendationJobRecord): Promise<Result<{ record: RecommendationJobRecord }>> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    let response;
    try {
      response = await getRecommendation({ region, recommendationId: record.id });
    } catch (err) {
      if (err instanceof JobNotFoundError) {
        return { success: true, record: { ...record, status: NOT_FOUND_STATUS } };
      }
      return { success: false, error: toError(err) };
    }

    const failureDetail =
      response.status === 'FAILED'
        ? extractFailureDetails({
            statusReasons: response.statusReasons,
            recommendationResult: response.recommendationResult,
          })
        : undefined;

    // `completedAt` must only be set once the job actually reaches a terminal state — the UI renders a
    // "Completed:" line whenever it is present. The service's `updatedAt` advances on every state
    // transition (incl. PENDING → IN_PROGRESS), so it is NOT a completion signal. For a non-terminal
    // status we leave `completedAt` unset (clearing any value a prior buggy refresh may have stored),
    // so a still-running job never renders as completed.
    const isTerminalStatus = TERMINAL_STATUSES.recommendation.has(response.status);
    const completedAt = isTerminalStatus
      ? (response.completedAt ?? response.updatedAt ?? record.completedAt)
      : undefined;

    return {
      success: true,
      record: {
        ...record,
        status: response.status,
        completedAt,
        result: response.recommendationResult ?? record.result,
        statusReasons: response.statusReasons ?? record.statusReasons,
        failureDetail: failureDetail ?? record.failureDetail,
      },
    };
  },

  async settle(record: RecommendationJobRecord, configIO: ConfigIO): Promise<RecommendationJobRecord> {
    // Only config-bundle recommendations that completed and produced a new bundle version, once.
    if (record.inputSource !== 'config-bundle' || record.status !== 'COMPLETED' || !record.result) {
      return record;
    }
    const resultBundle =
      record.result.systemPromptRecommendationResult?.configurationBundle ??
      record.result.toolDescriptionRecommendationResult?.configurationBundle;
    if (!resultBundle || record.syncedVersionId === resultBundle.versionId) {
      return record;
    }

    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    const applyResult = await applyRecommendationToBundle(
      { bundleName: record.bundleName, bundleArn: record.bundleArn, result: record.result, region },
      configIO
    );
    if (applyResult.success) {
      return { ...record, syncedVersionId: resultBundle.versionId };
    }
    return record; // leave unsynced so a later get()/list() retries
  },

  async archive(record: RecommendationJobRecord): Promise<Result> {
    const region = regionFromArn(record.arn) ?? (await detectRegion()).region;
    try {
      await deleteRecommendation({ region, recommendationId: record.id });
      return { success: true };
    } catch (err) {
      // Already gone on the service — local cleanup can still proceed.
      if (err instanceof JobNotFoundError) {
        return { success: true };
      }
      return { success: false, error: toError(err) };
    }
  },
};
