/**
 * Recommendation start-time pipeline, extracted from the legacy run-recommendation.ts so the
 * job handler's create() can reuse it. Owns: evaluator name→ARN resolution, account-id extraction,
 * config-bundle JSONPath component resolution, structured failure extraction, and the
 * recommendationConfig builder (which includes the slow sessions/spans-file span fetch).
 */
import { ValidationError } from '../../../../lib';
import type { DeployedState } from '../../../../schema';
import type {
  RecommendationConfig,
  RecommendationEvaluationConfig,
  RecommendationResult,
  RecommendationType,
  SessionSpan,
} from '../../../aws/agentcore-recommendation';
import { runtimeLogGroup } from '../../../aws/cloudwatch';
import { arnPrefix } from '../../../aws/partition';
import type { ExecLogger } from '../../../logging/exec-logger';
import { MAX_INLINE_SPANS, MAX_TOOL_NAME_LENGTH, TOOL_NAME_REGEX } from '../shared/constants';
import { fetchSessionSpans } from './fetch-session-spans';
import { readFileSync } from 'fs';

/** Resolve an evaluator reference to a full ARN (ARN passthrough, Builtin.* expansion, or deployed lookup). */
export function resolveEvaluatorId(
  deployedState: DeployedState,
  evaluator: string,
  region: string
): string | undefined {
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

/** Extract a 12-digit account id from an ARN, or '*' if not present. */
export function extractAccountIdFromArn(arn: string): string {
  const parts = arn.split(':');
  return parts[4] && /^\d{12}$/.test(parts[4]) ? parts[4] : '*';
}

/** Resolve a config-bundle component key ({{runtime:...}} / {{gateway:...}}) to a real ARN for JSONPath. */
export function resolveComponentKeyForJsonPath(key: string, deployedState: DeployedState): string {
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
      const httpGw = target.resources?.gateways?.[gwName];
      if (httpGw) return httpGw.gatewayArn;
      const mcpGw = target.resources?.mcp?.gateways?.[gwName];
      if (mcpGw) return mcpGw.gatewayArn;
    }
  }

  return key;
}

/**
 * Resolve a config-bundle version reference to a concrete version UUID.
 *
 * The recommendation API only accepts a concrete versionId — passing the literal 'LATEST' through
 * yields a 400 (versionId fails the UUID pattern). When 'LATEST' is given, look the bundle up in
 * deployed state (by ARN) and return its deployed versionId. An explicit version is returned
 * verbatim. Returns undefined when 'LATEST' cannot be resolved (bundle not deployed) so the caller
 * can surface a friendly error instead of sending 'LATEST' to the API. Mirrors the ab-test path's
 * resolveConfigBundleVersion.
 */
export function resolveBundleVersionId(
  bundleArn: string,
  versionRef: string,
  deployedState: DeployedState
): string | undefined {
  if (versionRef !== 'LATEST') return versionRef;
  for (const target of Object.values(deployedState.targets ?? {})) {
    const bundle = Object.values(target.resources?.configBundles ?? {}).find(b => b.bundleArn === bundleArn);
    if (bundle?.versionId) return bundle.versionId;
  }
  return undefined;
}

/** Flatten statusReasons + result errorCode/errorMessage into a single display string (FAILED only). */
export function extractFailureDetails(pollResult: {
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

export interface BuildConfigOptions {
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
  fromInsights?: string;
  batchEvaluationArn?: string;
  onlineEvaluationArn?: string;
  runtimeId: string;
  accountId: string;
  region: string;
  evaluatorIds: string[];
  onProgress?: (status: string, message: string) => void;
  logger?: ExecLogger;
}

/**
 * Build the recommendationConfig request body. For traceSource 'sessions'/'spans-file' this performs
 * the (slow, can-throw) client-side span fetch/read before returning — that work stays part of building
 * the request, surfaced via onProgress, and throws on empty so the handler returns {success:false}.
 */
export async function buildRecommendationConfig(opts: BuildConfigOptions): Promise<RecommendationConfig> {
  // Build agent traces — batch evaluation source, spans file, sessions, or CloudWatch
  let agentTraces;

  if (opts.traceSource === 'batch-evaluation') {
    let batchEvalArn: string;
    if (opts.batchEvaluationArn) {
      batchEvalArn = opts.batchEvaluationArn;
    } else if (opts.fromInsights) {
      const { loadRecord } = await import('../shared/storage');
      const record = loadRecord('insights', opts.fromInsights);
      if (!record) {
        throw new Error(`Insights run "${opts.fromInsights}" not found.`);
      }
      if (record.status !== 'COMPLETED' && record.status !== 'COMPLETED_WITH_ERRORS') {
        throw new Error(
          `Insights run "${opts.fromInsights}" has status ${record.status}. Only COMPLETED runs can be used as recommendation source.`
        );
      }
      batchEvalArn = record.arn;
    } else {
      throw new Error(
        'Either --from-insights or --batch-evaluation-arn is required for batch-evaluation trace source.'
      );
    }
    agentTraces = { batchEvaluation: { batchEvaluationArn: batchEvalArn } };
  } else if (opts.traceSource === 'online-evaluation') {
    if (!opts.onlineEvaluationArn) {
      throw new Error('--online-evaluation-arn is required for online-evaluation trace source.');
    }
    // Online evaluation is a continuous stream, so the recommendation reuses only
    // the scores in a bounded window. Derive it from --lookback-days (endTime = now),
    // matching the cloudwatch source's lookback semantics.
    const lookbackDays = opts.lookbackDays ?? 7;
    agentTraces = {
      onlineEvaluation: {
        onlineEvaluationConfigArn: opts.onlineEvaluationArn,
        startTime: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
      },
    };
  } else if (opts.traceSource === 'spans-file' && opts.spansFile) {
    // Explicit spans file — read and use as inline sessionSpans
    const spansContent = readFileSync(opts.spansFile, 'utf-8');
    const sessionSpans = JSON.parse(spansContent) as SessionSpan | SessionSpan[];
    const spansList = Array.isArray(sessionSpans) ? sessionSpans : [sessionSpans];
    if (spansList.length > MAX_INLINE_SPANS) {
      throw new ValidationError(
        `Spans file contains ${spansList.length} spans, which exceeds the maximum of ${MAX_INLINE_SPANS}. Reduce the number of spans or use CloudWatch-based trace collection instead.`
      );
    }
    agentTraces = { sessionSpans: spansList };
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
    if (allSpans.length > MAX_INLINE_SPANS) {
      throw new ValidationError(
        `Fetched ${allSpans.length} spans across the specified sessions, which exceeds the maximum of ${MAX_INLINE_SPANS}. Reduce the number of sessions or use CloudWatch-based trace collection instead.`
      );
    }

    opts.logger?.log(`Total spans fetched: ${allSpans.length}`);
    opts.onProgress?.('fetching-spans', `Fetched ${allSpans.length} spans`);
    agentTraces = { sessionSpans: allSpans };
  } else {
    // Lookback-based path — use cloudwatchLogs with time range
    const runtimeLogGroupArn = `${arnPrefix(opts.region)}:logs:${opts.region}:${opts.accountId}:log-group:${runtimeLogGroup(opts.runtimeId)}`;
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

  // With no evaluator (batch/online inheritance) the config is omitted so the service falls back to
  // the referenced evaluation's evaluator; building an empty {evaluators:[{}]} would be malformed.
  const evaluationConfig: RecommendationEvaluationConfig | undefined =
    opts.evaluatorIds.length > 0 ? { evaluators: [{ evaluatorArn: opts.evaluatorIds[0]! }] } : undefined;

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
        ...(evaluationConfig ? { evaluationConfig } : {}),
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
    const toolName = colonIdx > 0 ? t.slice(0, colonIdx) : t;
    if (!TOOL_NAME_REGEX.test(toolName) || toolName.length > MAX_TOOL_NAME_LENGTH) {
      throw new ValidationError(
        `Tool name "${toolName}" is invalid. Must contain only alphanumeric characters, underscores, hyphens, or dots (max ${MAX_TOOL_NAME_LENGTH} chars).`
      );
    }
    if (colonIdx > 0) {
      return { toolName, toolDescription: { text: t.slice(colonIdx + 1) } };
    }
    return { toolName, toolDescription: { text: opts.inlineContent ?? '' } };
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
