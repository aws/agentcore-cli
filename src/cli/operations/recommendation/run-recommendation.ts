/**
 * Orchestrates running a Recommendation:
 *   1. Resolve agent and evaluator from project
 *   2. Build recommendationConfig from CLI inputs
 *   3. Call StartRecommendation (creates resource, returns 202)
 *   4. Poll GetRecommendation until terminal status
 *   5. Return result with optimized artifact
 */
import { ConfigIO, ResourceNotFoundError, TimeoutError, ValidationError, toError } from '../../../lib';
import type { DeployedState } from '../../../schema';
import type {
  RecommendationConfig,
  RecommendationResult,
  RecommendationType,
  SessionSpan,
} from '../../aws/agentcore-recommendation';
import { getRecommendation, startRecommendation } from '../../aws/agentcore-recommendation';
import { arnPrefix } from '../../aws/partition';
import { detectRegion } from '../../aws/region';
import { ExecLogger } from '../../logging/exec-logger';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_DURATION_MS, MAX_POLL_RETRIES, TERMINAL_STATUSES } from './constants';
import { fetchSessionSpans } from './fetch-session-spans';
import type { RunRecommendationCommandOptions, RunRecommendationCommandResult } from './types';
import { readFileSync } from 'fs';

export async function runRecommendationCommand(
  options: RunRecommendationCommandOptions
): Promise<RunRecommendationCommandResult> {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, onProgress } = options;
  let logger: ExecLogger | undefined;
  try {
    logger = new ExecLogger({ command: 'recommend' });
  } catch {
    // Logger creation can fail in tests or when no project root exists — non-fatal
  }

  try {
    logger?.startStep('Load project config');
    // 1. Read project config and deployed state
    const configIO = new ConfigIO();
    const [projectSpec, deployedState, awsTargets] = await Promise.all([
      configIO.readProjectSpec(),
      configIO.readDeployedState(),
      configIO.resolveAWSDeploymentTargets(),
    ]);

    const targetRegion = awsTargets.length > 0 ? awsTargets[0]!.region : undefined;
    const { region: detectedRegion } = await detectRegion();
    const region = options.region ?? targetRegion ?? detectedRegion;
    const stage = process.env.AGENTCORE_STAGE?.toLowerCase() ?? 'prod';
    logger?.log(`Region: ${region}, Stage: ${stage}`);
    logger?.endStep('success');

    // 2. Resolve agent from deployed state (needed for log group ARNs)
    logger?.startStep('Resolve agent and evaluators');
    const agentState = resolveAgentState(deployedState, options.agent);
    if (!agentState) {
      logger?.log(`Agent "${options.agent}" not found in deployed state`, 'error');
      logger?.endStep('error', `Agent "${options.agent}" not deployed`);
      logger?.finalize(false);
      return {
        success: false,
        error: new Error(`Agent "${options.agent}" not deployed. Run \`agentcore deploy\` first.`),
        logFilePath: logger?.logFilePath,
      };
    }
    logger?.log(`Agent: ${options.agent} (runtime: ${agentState.runtimeId})`);

    // 3. Resolve evaluator ID/ARN (API accepts exactly one for system-prompt, none for tool-desc)
    const evaluatorIds: string[] = [];
    for (const evaluator of options.evaluators) {
      const evaluatorId = resolveEvaluatorId(deployedState, evaluator, region);
      if (!evaluatorId) {
        return {
          success: false,
          error: new Error(
            `Evaluator "${evaluator}" not found in deployed state. Use a Builtin.* name, a full ARN, or deploy a custom evaluator first.`
          ),
          logFilePath: logger?.logFilePath,
        };
      }
      evaluatorIds.push(evaluatorId);
    }
    if (options.type === 'SYSTEM_PROMPT_RECOMMENDATION' && evaluatorIds.length !== 1) {
      return {
        success: false,
        error: new ValidationError('System prompt recommendations require exactly one evaluator.'),
        logFilePath: logger?.logFilePath,
      };
    }
    logger?.log(`Evaluators: ${evaluatorIds.join(', ') || '(none)'}`);
    logger?.endStep('success');

    // 4. Read input content (if from file)
    let inlineContent: string | undefined;
    if (options.inputSource === 'file' && options.promptFile) {
      inlineContent = readFileSync(options.promptFile, 'utf-8');
    } else if (options.inputSource === 'inline') {
      inlineContent = options.inlineContent;
    }

    // Validate that system prompt content is non-empty (API rejects empty text)
    if (
      options.type === 'SYSTEM_PROMPT_RECOMMENDATION' &&
      options.inputSource !== 'config-bundle' &&
      !inlineContent?.trim()
    ) {
      return {
        success: false,
        error: new ValidationError(
          'System prompt content is required. Provide via --inline, --prompt-file, or --bundle-name.'
        ),
        logFilePath: logger?.logFilePath,
      };
    }

    // 5. Extract account ID from agent runtime ARN
    const accountId = extractAccountIdFromArn(agentState.runtimeArn);

    // 5b. Resolve config bundle ARN from deployed state (if using config bundle)
    let bundleArn: string | undefined;
    if (options.inputSource === 'config-bundle' && options.bundleName) {
      if (options.bundleName.startsWith('arn:')) {
        // Already an ARN (e.g. from TUI which stores the ARN directly)
        bundleArn = options.bundleName;
      } else {
        // Human-readable name (e.g. from CLI --bundle-name flag) — resolve from deployed state
        for (const targetName of Object.keys(deployedState.targets ?? {})) {
          const target = deployedState.targets?.[targetName];
          const bundle = target?.resources?.configBundles?.[options.bundleName];
          if (bundle?.bundleArn) {
            bundleArn = bundle.bundleArn;
            break;
          }
        }
        if (!bundleArn) {
          return {
            success: false,
            error: new ResourceNotFoundError(
              `Config bundle "${options.bundleName}" not found in deployed state. Run \`agentcore deploy\` first.`
            ),
            logFilePath: logger?.logFilePath,
          };
        }
      }
      logger?.log(`Resolved bundle ARN: ${bundleArn}`);
    }

    // 5c. Resolve short-form systemPromptJsonPath (e.g. "systemPrompt") to full JSONPath
    let resolvedSystemPromptJsonPath = options.systemPromptJsonPath;
    if (
      options.inputSource === 'config-bundle' &&
      options.bundleName &&
      resolvedSystemPromptJsonPath &&
      !resolvedSystemPromptJsonPath.startsWith('$')
    ) {
      // User provided a short field name like "systemPrompt" — resolve from agentcore.json
      const bundleName = options.bundleName.startsWith('arn:')
        ? // Find bundle name from ARN by matching deployed state
          Object.values(deployedState.targets)
            .flatMap(t => Object.entries(t.resources?.configBundles ?? {}))
            .find(([, b]) => b.bundleArn === options.bundleName)?.[0]
        : options.bundleName;

      if (bundleName) {
        const projBundle = projectSpec.configBundles?.find(b => b.name === bundleName);
        if (projBundle?.components) {
          const subPath = resolvedSystemPromptJsonPath;
          // Use the first component key, resolved to a real ARN
          const firstComponentKey = Object.keys(projBundle.components)[0];
          if (firstComponentKey) {
            const resolvedKey = resolveComponentKeyForJsonPath(firstComponentKey, deployedState);
            resolvedSystemPromptJsonPath = `$.${resolvedKey}.configuration.${subPath}`;
            logger?.log(`Resolved short JSONPath "${subPath}" → "${resolvedSystemPromptJsonPath}"`);
          }
        }
      }
    }

    // 6. Build recommendationConfig based on type
    const recommendationConfig = await buildRecommendationConfig({
      type: options.type,
      inlineContent,
      bundleArn,
      bundleVersion: options.bundleVersion,
      systemPromptJsonPath: resolvedSystemPromptJsonPath,
      toolDescJsonPaths: options.toolDescJsonPaths,
      inputSource: options.inputSource,
      tools: options.tools,
      traceSource: options.traceSource,
      lookbackDays: options.lookbackDays,
      sessionIds: options.sessionIds,
      spansFile: options.spansFile,
      runtimeId: agentState.runtimeId,
      accountId,
      region,
      evaluatorIds,
      onProgress,
      logger,
    });

    // 7. Start the recommendation
    logger?.startStep('Start recommendation');
    const recommendationName = options.recommendationName ?? `${projectSpec.name}_${options.agent}_${Date.now()}`;
    onProgress?.('starting', `Starting recommendation "${recommendationName}"...`);

    const startPayload = {
      region,
      name: recommendationName,
      type: options.type,
      recommendationConfig,
    };
    logger?.log(`Request payload:\n${JSON.stringify(startPayload, null, 2)}`);

    const startResult = await startRecommendation(startPayload);

    logger?.log(`Response: ${JSON.stringify(startResult, null, 2)}`);
    logger?.endStep('success');
    onProgress?.('started', `Recommendation created: ${startResult.recommendationId} (status: ${startResult.status})`);
    options.onStarted?.({ recommendationId: startResult.recommendationId, region });

    // 8. Poll GetRecommendation until terminal status
    logger?.startStep('Poll for completion');
    const maxDurationMs = options.maxPollDurationMs ?? MAX_POLL_DURATION_MS;
    const pollStartTime = Date.now();
    let currentStatus = startResult.status;
    let consecutiveFailures = 0;

    while (!TERMINAL_STATUSES.has(currentStatus)) {
      await sleep(pollIntervalMs);

      // Check max poll duration
      if (Date.now() - pollStartTime > maxDurationMs) {
        logger?.log(`Max poll duration (${maxDurationMs}ms) exceeded`, 'error');
        logger?.endStep('error', 'Poll timeout');
        logger?.finalize(false);
        return {
          success: false,
          error: new TimeoutError(
            `Polling timed out after ${Math.round(maxDurationMs / 60000)} minutes. The recommendation may still be running server-side.\nRecommendation ID: ${startResult.recommendationId}`
          ),
          recommendationId: startResult.recommendationId,
          status: currentStatus,
          logFilePath: logger?.logFilePath,
        };
      }

      // Poll with retry for transient failures
      let pollResult;
      try {
        pollResult = await getRecommendation({
          region,
          recommendationId: startResult.recommendationId,
        });
        consecutiveFailures = 0;
      } catch (pollErr) {
        consecutiveFailures++;
        const pollErrMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
        logger?.log(`Poll attempt failed (${consecutiveFailures}/${MAX_POLL_RETRIES}): ${pollErrMsg}`, 'error');

        if (consecutiveFailures >= MAX_POLL_RETRIES) {
          logger?.endStep('error', `${MAX_POLL_RETRIES} consecutive poll failures`);
          logger?.finalize(false);
          return {
            success: false,
            error: new TimeoutError(
              `Polling failed after ${MAX_POLL_RETRIES} consecutive errors: ${pollErrMsg}\nThe recommendation may still be running server-side.\nRecommendation ID: ${startResult.recommendationId}`
            ),
            recommendationId: startResult.recommendationId,
            status: currentStatus,
            logFilePath: logger?.logFilePath,
          };
        }
        onProgress?.('polling', `Poll error, retrying (${consecutiveFailures}/${MAX_POLL_RETRIES})...`);
        continue;
      }

      currentStatus = pollResult.status;
      onProgress?.('polling', `Status: ${currentStatus}`);

      if (TERMINAL_STATUSES.has(currentStatus)) {
        if (currentStatus === 'COMPLETED' || currentStatus === 'SUCCEEDED') {
          logger?.log(`Completed. Result:\n${JSON.stringify(pollResult.recommendationResult, null, 2)}`);
          logger?.endStep('success');
          logger?.finalize(true);
          return {
            success: true,
            recommendationId: startResult.recommendationId,
            status: currentStatus,
            result: pollResult.recommendationResult,
            region,
            startedAt: pollResult.createdAt,
            completedAt: pollResult.completedAt,
            logFilePath: logger?.logFilePath,
          };
        }

        // Extract error details from the FAILED response
        const failureDetails = extractFailureDetails(pollResult);
        logger?.log(`Terminal status: ${currentStatus}`, 'error');
        logger?.log(`Full poll response:\n${JSON.stringify(pollResult, null, 2)}`, 'error');
        if (failureDetails) logger?.log(`Failure details: ${failureDetails}`, 'error');
        logger?.endStep('error', `Status: ${currentStatus}`);
        logger?.finalize(false);
        // Log request IDs for debugging (only in log file, not shown in TUI)
        const requestIds = [
          startResult.requestId ? `Start: ${startResult.requestId}` : '',
          pollResult.requestId ? `Poll: ${pollResult.requestId}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        if (requestIds) logger?.log(`Request IDs: ${requestIds}`, 'error');

        return {
          success: false,
          error: new Error(
            failureDetails
              ? `Recommendation failed: ${failureDetails}`
              : `Recommendation finished with status: ${currentStatus}`
          ),
          recommendationId: startResult.recommendationId,
          status: currentStatus,
          logFilePath: logger?.logFilePath,
        };
      }
    }

    // Should not reach here, but handle gracefully
    logger?.log(`Unexpected terminal status: ${currentStatus}`, 'error');
    logger?.endStep('error', `Unexpected status: ${currentStatus}`);
    logger?.finalize(false);
    return {
      success: false,
      error: new Error(`Recommendation ended with unexpected status: ${currentStatus}`),
      recommendationId: startResult.recommendationId,
      status: currentStatus,
      logFilePath: logger?.logFilePath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger?.log(`Error: ${errorMsg}`, 'error');
    logger?.endStep('error', errorMsg);
    logger?.finalize(false);
    return {
      success: false,
      error: toError(err),
      logFilePath: logger?.logFilePath,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function resolveAgentState(
  deployedState: DeployedState,
  agentName: string
): { runtimeId: string; runtimeArn: string } | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const agent = target.resources?.runtimes?.[agentName];
    if (agent) return agent;
  }
  return undefined;
}

/**
 * Resolve an evaluator name to a full ARN.
 * Returns undefined if the evaluator cannot be resolved.
 */
function resolveEvaluatorId(deployedState: DeployedState, evaluator: string, region: string): string | undefined {
  // Already a full ARN — use as-is
  if (evaluator.startsWith('arn:')) {
    return evaluator;
  }
  // Builtin shorthand → expand to full ARN
  if (evaluator.startsWith('Builtin.')) {
    return `${arnPrefix(region)}:bedrock-agentcore:::evaluator/${evaluator}`;
  }
  // Look up custom evaluator from deployed state
  for (const target of Object.values(deployedState.targets)) {
    const evalState = target.resources?.evaluators?.[evaluator];
    if (evalState) return evalState.evaluatorArn;
  }
  return undefined;
}

/**
 * Extract the 12-digit AWS account ID from an ARN.
 * Falls back to '*' if the ARN format is unexpected.
 */
function extractAccountIdFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts[4] && /^\d{12}$/.test(parts[4]) ? parts[4] : '*';
}

interface BuildConfigOptions {
  type: RecommendationType;
  inlineContent?: string;
  bundleArn?: string;
  bundleVersion?: string;
  systemPromptJsonPath?: string;
  toolDescJsonPaths?: { toolName: string; toolDescriptionJsonPath: string }[];
  inputSource: string;
  tools?: string[];
  traceSource: string;
  lookbackDays?: number;
  sessionIds?: string[];
  spansFile?: string;
  runtimeId: string;
  accountId: string;
  region: string;
  evaluatorIds: string[];
  onProgress?: (status: string, message: string) => void;
  logger?: ExecLogger;
}

async function buildRecommendationConfig(opts: BuildConfigOptions): Promise<RecommendationConfig> {
  // Build agent traces — either from a spans file (inline session spans) or CloudWatch
  let agentTraces;

  if (opts.traceSource === 'spans-file' && opts.spansFile) {
    // Explicit spans file — read and use as inline sessionSpans
    const spansContent = readFileSync(opts.spansFile, 'utf-8');
    const sessionSpans = JSON.parse(spansContent) as SessionSpan | SessionSpan[];
    agentTraces = {
      sessionSpans: Array.isArray(sessionSpans) ? sessionSpans : [sessionSpans],
    };
  } else if (opts.traceSource === 'sessions' && opts.sessionIds && opts.sessionIds.length > 0) {
    // Session IDs selected — auto-fetch from both log groups and use inline sessionSpans.
    // The CloudWatch trace config does not support filtering by multiple session IDs,
    // so we fetch spans client-side and send them inline.
    opts.onProgress?.('fetching-spans', 'Fetching session spans from CloudWatch...');
    opts.logger?.log(
      'Auto-fetching spans for selected sessions (CloudWatch config does not support session ID filtering)'
    );

    const allSpans = [];
    for (const sessionId of opts.sessionIds) {
      const result = await fetchSessionSpans({
        region: opts.region,
        runtimeId: opts.runtimeId,
        sessionId,
        lookbackDays: opts.lookbackDays ?? 7,
        onProgress: msg => {
          opts.logger?.log(msg);
          opts.onProgress?.('fetching-spans', msg);
        },
      });
      allSpans.push(...result.spans);
    }

    if (allSpans.length === 0) {
      throw new Error(
        'No spans found for the specified session(s). Ensure the agent has been invoked and traces have propagated to CloudWatch (may take 5-10 minutes).'
      );
    }

    opts.logger?.log(`Total spans fetched: ${allSpans.length}`);
    opts.onProgress?.('fetching-spans', `Fetched ${allSpans.length} spans`);
    agentTraces = { sessionSpans: allSpans };
  } else {
    // Lookback-based path — use cloudwatchLogs with time range
    const runtimeLogGroupArn = `${arnPrefix(opts.region)}:logs:${opts.region}:${opts.accountId}:log-group:/aws/bedrock-agentcore/runtimes/${opts.runtimeId}-DEFAULT`;
    const spansLogGroupArn = `${arnPrefix(opts.region)}:logs:${opts.region}:${opts.accountId}:log-group:aws/spans`;

    // Derive service name: strip the random hash suffix from runtimeId
    // runtimeId format: {project}_{agent}-{hash} → serviceName: {project}_{agent}.DEFAULT
    const serviceName = opts.runtimeId.replace(/-[^-]+$/, '.DEFAULT');

    const lookbackDays = opts.lookbackDays ?? 7;
    agentTraces = {
      cloudwatchLogs: {
        logGroupArns: [runtimeLogGroupArn, spansLogGroupArn],
        serviceNames: [serviceName],
        startTime: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
      },
    };
  }

  const evaluationConfig: import('../../aws/agentcore-recommendation').RecommendationEvaluationConfig = {
    evaluators: [{ evaluatorArn: opts.evaluatorIds[0]! }],
  };

  // Validate required fields for config-bundle source (API requires all three)
  if (opts.inputSource === 'config-bundle' && opts.bundleArn && !opts.bundleVersion) {
    throw new Error('Config bundle version is required. Provide --bundle-version or deploy the bundle first.');
  }

  if (opts.inputSource === 'config-bundle' && opts.bundleArn) {
    if (opts.type === 'SYSTEM_PROMPT_RECOMMENDATION' && !opts.systemPromptJsonPath) {
      throw new Error(
        'Config bundle requires --system-prompt-json-path to locate the system prompt field.\n' +
          "Use the field name (e.g. --system-prompt-json-path 'systemPrompt') and it will be resolved from agentcore.json.\n" +
          "Or provide the full JSONPath (e.g. '$.ARN.configuration.systemPrompt')."
      );
    }
    if (opts.type === 'TOOL_DESCRIPTION_RECOMMENDATION' && !opts.toolDescJsonPaths?.length) {
      throw new Error(
        'Config bundle requires --tool-desc-json-path to locate tool description fields.\n' +
          "Example: --tool-desc-json-path 'toolName:$.ARN.configuration.toolDescription'"
      );
    }
  }

  if (opts.type === 'SYSTEM_PROMPT_RECOMMENDATION') {
    return {
      systemPromptRecommendationConfig: {
        systemPrompt:
          opts.inputSource === 'config-bundle' && opts.bundleArn
            ? {
                configurationBundle: {
                  bundleArn: opts.bundleArn,
                  versionId: opts.bundleVersion!,
                  systemPromptJsonPath: opts.systemPromptJsonPath,
                },
              }
            : { text: opts.inlineContent ?? '' },
        agentTraces,
        evaluationConfig,
      },
    };
  }

  // TOOL_DESCRIPTION_RECOMMENDATION
  if (opts.inputSource === 'config-bundle' && opts.bundleArn && opts.toolDescJsonPaths?.length) {
    // Config bundle source — pass bundle reference with JSON paths for server-side resolution
    return {
      toolDescriptionRecommendationConfig: {
        toolDescription: {
          configurationBundle: {
            bundleArn: opts.bundleArn,
            versionId: opts.bundleVersion!,
            tools: opts.toolDescJsonPaths,
          },
        },
        agentTraces,
      },
    };
  }

  // Inline/file source — parse "toolName:description" pairs from tools array
  const toolEntries = (opts.tools ?? []).map(t => {
    const colonIdx = t.indexOf(':');
    if (colonIdx > 0) {
      return { toolName: t.slice(0, colonIdx), toolDescription: { text: t.slice(colonIdx + 1) } };
    }
    return { toolName: t, toolDescription: { text: opts.inlineContent ?? '' } };
  });

  return {
    toolDescriptionRecommendationConfig: {
      toolDescription: {
        toolDescriptionText: {
          tools: toolEntries,
        },
      },
      agentTraces,
    },
  };
}

/**
 * Extract error details from a FAILED recommendation response.
 * The API populates errorCode/errorMessage in the result, and statusReasons at top level.
 */
function extractFailureDetails(pollResult: {
  statusReasons?: string[];
  recommendationResult?: RecommendationResult;
}): string | undefined {
  const parts: string[] = [];

  if (pollResult.statusReasons?.length) {
    parts.push(pollResult.statusReasons.join('; '));
  }

  const result = pollResult.recommendationResult;
  if (result) {
    const errorSource = result.systemPromptRecommendationResult ?? result.toolDescriptionRecommendationResult;
    if (errorSource) {
      if (errorSource.errorCode) parts.push(`[${errorSource.errorCode}]`);
      if (errorSource.errorMessage) parts.push(errorSource.errorMessage);
    }
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Resolve a component key (which may be a placeholder like {{runtime:name}})
 * to its real ARN from deployed state. Returns the key unchanged if not a placeholder.
 */
function resolveComponentKeyForJsonPath(key: string, deployedState: DeployedState): string {
  if (key.startsWith('arn:')) return key;

  const rtMatch = /^\{\{runtime:(.+)\}\}$/.exec(key);
  if (rtMatch) {
    const rtName = rtMatch[1]!;
    for (const target of Object.values(deployedState.targets)) {
      const rt = target.resources?.runtimes?.[rtName];
      if (rt) return rt.runtimeArn;
    }
  }

  const gwMatch = /^\{\{gateway:(.+)\}\}$/.exec(key);
  if (gwMatch) {
    const gwName = gwMatch[1]!;
    for (const target of Object.values(deployedState.targets)) {
      const httpGw = target.resources?.httpGateways?.[gwName];
      if (httpGw) return httpGw.gatewayArn;
      const mcpGw = target.resources?.mcp?.gateways?.[gwName];
      if (mcpGw) return mcpGw.gatewayArn;
    }
  }

  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
