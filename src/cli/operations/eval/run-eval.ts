import { getCredentialProvider } from '../../aws';
import { evaluate } from '../../aws/agentcore';
import { getEvaluator } from '../../aws/agentcore-control';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import type { DeployedProjectConfig } from '../resolve-agent';
import { loadDeployedProjectConfig, resolveAgent } from '../resolve-agent';
import { generateFilename, saveEvalRun } from './storage';
import type { EvalEvaluatorResult, EvalRunResult, EvalSessionScore, RunEvalOptions, SessionInfo } from './types';
import type { EvaluationReferenceInput } from '@aws-sdk/client-bedrock-agentcore';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';
import type { DocumentType } from '@smithy/types';
import { writeFileSync } from 'fs';
import { join } from 'path';

const SPANS_LOG_GROUP = 'aws/spans';

const SUPPORTED_SCOPES = new Set([
  'strands.telemetry.tracer',
  'opentelemetry.instrumentation.langchain',
  'openinference.instrumentation.langchain',
]);

interface ResolvedEvalContext {
  agentLabel: string;
  region: string;
  runtimeId: string;
  runtimeLogGroup: string;
  evaluatorIds: string[];
  evaluatorLabels: string[];
}

type ResolveResult = { success: true; ctx: ResolvedEvalContext } | { success: false; error: string };

/**
 * Resolve evaluator IDs from ARN strings or raw IDs.
 * Returns the extracted evaluator ID (last segment of ARN, or the value as-is).
 */
function resolveEvaluatorArns(arns: string[]): string[] {
  return arns.map(arnOrId => {
    const arnMatch = /evaluator\/(.+)$/.exec(arnOrId);
    return arnMatch ? arnMatch[1]! : arnOrId;
  });
}

/**
 * ARN mode: resolve context directly from an agent runtime ARN.
 * No project config needed.
 */
function resolveFromArn(options: RunEvalOptions): ResolveResult {
  const arn = options.agentArn!;

  // Parse ARN: arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtimeId>
  const arnParts = arn.split(':');
  if (arnParts.length < 6) {
    return { success: false, error: `Invalid agent runtime ARN: ${arn}` };
  }

  const region = options.region ?? arnParts[3];
  if (!region) {
    return { success: false, error: 'Could not determine region from ARN. Use --region to specify.' };
  }

  const resourcePart = arnParts.slice(5).join(':');
  const runtimeMatch = /runtime\/(.+)$/.exec(resourcePart);
  if (!runtimeMatch) {
    return { success: false, error: `Could not extract runtime ID from ARN: ${arn}` };
  }
  const runtimeId = runtimeMatch[1]!;

  // In ARN mode, evaluators must come from --evaluator-arn or Builtin.* names
  const evaluatorIds: string[] = [];
  const evaluatorLabels: string[] = [];

  for (const evalName of options.evaluator) {
    if (evalName.startsWith('Builtin.')) {
      evaluatorIds.push(evalName);
      evaluatorLabels.push(evalName);
    } else {
      return {
        success: false,
        error: `Custom evaluator "${evalName}" cannot be resolved in ARN mode. Use --evaluator-arn with an evaluator ARN or ID, or use Builtin.* evaluators.`,
      };
    }
  }

  if (options.evaluatorArn) {
    const resolved = resolveEvaluatorArns(options.evaluatorArn);
    evaluatorIds.push(...resolved);
    evaluatorLabels.push(...options.evaluatorArn);
  }

  if (evaluatorIds.length === 0) {
    return { success: false, error: 'No evaluators specified. Use -e/--evaluator with Builtin.* or --evaluator-arn.' };
  }

  const endpointName = options.endpoint ?? process.env.AGENTCORE_RUNTIME_ENDPOINT ?? DEFAULT_ENDPOINT_NAME;
  const runtimeLogGroup = `/aws/bedrock-agentcore/runtimes/${runtimeId}-${endpointName}`;

  return {
    success: true,
    ctx: {
      agentLabel: runtimeId,
      region,
      runtimeId,
      runtimeLogGroup,
      evaluatorIds,
      evaluatorLabels,
    },
  };
}

/**
 * Project mode: resolve context from agentcore.json + deployed-state.json.
 */
function resolveFromProject(context: DeployedProjectConfig, options: RunEvalOptions): ResolveResult {
  const agentResult = resolveAgent(context, { runtime: options.agent });
  if (!agentResult.success) {
    return agentResult;
  }

  const { agent } = agentResult;
  const endpointName = options.endpoint ?? process.env.AGENTCORE_RUNTIME_ENDPOINT ?? DEFAULT_ENDPOINT_NAME;
  const runtimeLogGroup = `/aws/bedrock-agentcore/runtimes/${agent.runtimeId}-${endpointName}`;

  // Resolve evaluator names to IDs
  const evaluatorIds: string[] = [];
  const evaluatorLabels: string[] = [];
  const targetResources = context.deployedState.targets[agent.targetName]?.resources;

  for (const evalName of options.evaluator) {
    if (evalName.startsWith('Builtin.')) {
      evaluatorIds.push(evalName);
      evaluatorLabels.push(evalName);
      continue;
    }

    const deployedEval = targetResources?.evaluators?.[evalName];
    if (!deployedEval) {
      return {
        success: false,
        error: `Evaluator "${evalName}" not found in deployed state. Has it been deployed?`,
      };
    }
    evaluatorIds.push(deployedEval.evaluatorId);
    evaluatorLabels.push(evalName);
  }

  // Also add any direct ARNs/IDs
  if (options.evaluatorArn) {
    const resolved = resolveEvaluatorArns(options.evaluatorArn);
    evaluatorIds.push(...resolved);
    evaluatorLabels.push(...options.evaluatorArn);
  }

  if (evaluatorIds.length === 0) {
    return { success: false, error: 'No evaluators specified. Use -e/--evaluator or --evaluator-arn.' };
  }

  return {
    success: true,
    ctx: {
      agentLabel: agent.agentName,
      region: agent.region,
      runtimeId: agent.runtimeId,
      runtimeLogGroup,
      evaluatorIds,
      evaluatorLabels,
    },
  };
}

type EvaluatorLevel = 'SESSION' | 'TRACE' | 'TOOL_CALL';

const BUILTIN_EVALUATOR_LEVELS: Record<string, EvaluatorLevel> = {
  'Builtin.GoalSuccessRate': 'SESSION',
  'Builtin.Correctness': 'TRACE',
  'Builtin.Faithfulness': 'TRACE',
  'Builtin.Helpfulness': 'TRACE',
  'Builtin.ResponseRelevance': 'TRACE',
  'Builtin.Conciseness': 'TRACE',
  'Builtin.Coherence': 'TRACE',
  'Builtin.InstructionFollowing': 'TRACE',
  'Builtin.Refusal': 'TRACE',
  'Builtin.ToolSelectionAccuracy': 'TOOL_CALL',
};

/**
 * Resolve the evaluation level for each evaluator.
 * Builtin evaluators use a known mapping; custom evaluators are fetched via the API.
 */
async function resolveEvaluatorLevels(evaluatorIds: string[], region: string): Promise<Map<string, EvaluatorLevel>> {
  const levels = new Map<string, EvaluatorLevel>();

  for (const id of evaluatorIds) {
    const builtinLevel = BUILTIN_EVALUATOR_LEVELS[id];
    if (builtinLevel) {
      levels.set(id, builtinLevel);
      continue;
    }

    // Unknown builtin — default to SESSION
    if (id.startsWith('Builtin.')) {
      levels.set(id, 'SESSION');
      continue;
    }

    // Custom evaluator — fetch level from API
    try {
      const evaluator = await getEvaluator({ region, evaluatorId: id });
      levels.set(id, (evaluator.level as EvaluatorLevel) ?? 'SESSION');
    } catch {
      // If we can't determine the level, default to SESSION (most permissive)
      levels.set(id, 'SESSION');
    }
  }

  return levels;
}

/**
 * Extract distinct trace IDs from session spans.
 */
function extractTraceIds(spans: DocumentType[]): string[] {
  const traceIds = new Set<string>();
  for (const span of spans) {
    const traceId = (span as Record<string, unknown>).traceId as string | undefined;
    if (traceId) {
      traceIds.add(traceId);
    }
  }
  return [...traceIds];
}

/**
 * Extract span IDs that represent tool calls from session spans.
 */
function extractToolCallSpanIds(spans: DocumentType[]): string[] {
  const spanIds: string[] = [];
  for (const span of spans) {
    const doc = span as Record<string, unknown>;
    const spanId = doc.spanId as string | undefined;
    if (!spanId) continue;

    // Tool call spans must have a tool name attribute — kind=CLIENT alone is too broad
    const attrs = doc.attributes as Record<string, unknown> | undefined;
    if (attrs?.['gen_ai.tool.name'] ?? attrs?.['tool.name']) {
      spanIds.push(spanId);
    }
  }
  return spanIds;
}

const EVALUATE_TARGET_BATCH_SIZE = 10;

interface TargetIdBatch {
  traceIds?: string[];
  spanIds?: string[];
}

/**
 * Batch targetTraceIds / targetSpanIds into chunks of EVALUATE_TARGET_BATCH_SIZE.
 * The Evaluate API limits these arrays to 10 items per call.
 * For SESSION-level evaluators (both undefined), returns a single batch with no IDs.
 */
function batchTargetIds(traceIds?: string[], spanIds?: string[]): TargetIdBatch[] {
  if (spanIds) {
    return chunk(spanIds, EVALUATE_TARGET_BATCH_SIZE).map(batch => ({ spanIds: batch }));
  }
  if (traceIds) {
    return chunk(traceIds, EVALUATE_TARGET_BATCH_SIZE).map(batch => ({ traceIds: batch }));
  }
  // SESSION level — single call with no target IDs
  return [{}];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Execute a CloudWatch Logs Insights query and wait for results.
 */
async function executeQuery(
  client: CloudWatchLogsClient,
  logGroupName: string,
  queryString: string,
  startTimeSec: number,
  endTimeSec: number
): Promise<ResultField[][]> {
  const startQuery = await client.send(
    new StartQueryCommand({
      logGroupName,
      startTime: startTimeSec,
      endTime: endTimeSec,
      queryString,
    })
  );

  if (!startQuery.queryId) {
    throw new Error('Failed to start CloudWatch Logs Insights query');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const queryResults = await client.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));
    const status = queryResults.status ?? 'Unknown';

    if (status === 'Failed' || status === 'Cancelled') {
      throw new Error(`CloudWatch query ${status.toLowerCase()}`);
    }

    if (status === 'Complete') {
      return queryResults.results ?? [];
    }
  }

  throw new Error('CloudWatch query timed out after 60 seconds');
}

/**
 * Extract parsed @message documents from CloudWatch Insights results.
 */
function extractMessages(rows: ResultField[][]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  for (const row of rows) {
    const messageField = row.find(f => f.field === '@message');
    if (messageField?.value) {
      try {
        docs.push(JSON.parse(messageField.value) as Record<string, unknown>);
      } catch {
        // Skip non-JSON log lines
      }
    }
  }
  return docs;
}

/**
 * Check if a document is relevant for evaluation:
 * - Has a supported instrumentation scope, OR
 * - Is a log record with conversation data (body.input / body.output)
 */
function isRelevantForEval(doc: Record<string, unknown>): boolean {
  const scope = doc.scope as Record<string, unknown> | undefined;
  const scopeName = scope?.name as string | undefined;
  if (scopeName && SUPPORTED_SCOPES.has(scopeName)) {
    return true;
  }

  const body = doc.body;
  if (body && typeof body === 'object' && ('input' in body || 'output' in body)) {
    return true;
  }

  return false;
}

/** Sanitize a value for use in CloudWatch Insights query strings by removing single quotes. */
function sanitizeQueryValue(value: string): string {
  return value.replace(/'/g, '');
}

const MAX_DISCOVERED_SESSIONS = 50;

export interface DiscoverSessionsOptions {
  runtimeId: string;
  region: string;
  lookbackDays: number;
}

/**
 * Lightweight session discovery — returns session IDs with span counts,
 * without fetching full span data. Used by the TUI to let users pick sessions.
 */
export async function discoverSessions(opts: DiscoverSessionsOptions): Promise<SessionInfo[]> {
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - opts.lookbackDays * 24 * 60 * 60 * 1000;
  const startTimeSec = Math.floor(startTimeMs / 1000);
  const endTimeSec = Math.floor(endTimeMs / 1000);

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region: opts.region,
  });

  const query = `fields attributes.session.id as sessionId
     | parse resource.attributes.cloud.resource_id "runtime/*/" as parsedAgentId
     | filter parsedAgentId = '${sanitizeQueryValue(opts.runtimeId)}'
     | stats count(*) as spanCount, min(@timestamp) as firstSeen by sessionId
     | sort firstSeen desc
     | limit ${MAX_DISCOVERED_SESSIONS}`;

  const rows = await executeQuery(client, SPANS_LOG_GROUP, query, startTimeSec, endTimeSec);

  const sessions: SessionInfo[] = [];
  for (const row of rows) {
    const sessionId = row.find(f => f.field === 'sessionId')?.value;
    const spanCount = parseInt(row.find(f => f.field === 'spanCount')?.value ?? '0', 10);
    const firstSeen = row.find(f => f.field === 'firstSeen')?.value ?? '';
    if (sessionId && sessionId !== 'unknown') {
      sessions.push({ sessionId, spanCount, firstSeen });
    }
  }

  return sessions;
}

interface SessionSpans {
  sessionId: string;
  spans: DocumentType[];
}

interface FetchSpansOptions {
  runtimeId: string;
  runtimeLogGroup: string;
  region: string;
  lookbackDays: number;
  sessionId?: string;
  traceId?: string;
}

/**
 * Fetch OTel spans from the `aws/spans` log group and runtime logs from the agent's
 * log group, then group them by session.
 *
 * The Evaluate API requires spans from a single session per call.
 */
async function fetchSessionSpans(opts: FetchSpansOptions): Promise<SessionSpans[]> {
  const { runtimeId, runtimeLogGroup, region, lookbackDays } = opts;
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - lookbackDays * 24 * 60 * 60 * 1000;
  const startTimeSec = Math.floor(startTimeMs / 1000);
  const endTimeSec = Math.floor(endTimeMs / 1000);

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region,
  });

  // 1. Query proper OTel spans from the aws/spans log group
  let spanQuery = `fields @message, attributes.session.id as sessionId, traceId
     | parse resource.attributes.cloud.resource_id "runtime/*/" as parsedAgentId
     | filter parsedAgentId = '${sanitizeQueryValue(runtimeId)}'`;

  if (opts.sessionId) {
    spanQuery += `\n     | filter attributes.session.id = '${sanitizeQueryValue(opts.sessionId)}'`;
  }
  if (opts.traceId) {
    spanQuery += `\n     | filter traceId = '${sanitizeQueryValue(opts.traceId)}'`;
  }

  spanQuery += `\n     | sort startTimeUnixNano asc\n     | limit 10000`;

  const spanRows = await executeQuery(client, SPANS_LOG_GROUP, spanQuery, startTimeSec, endTimeSec);

  // Group spans by session and collect trace IDs
  const sessionMap = new Map<string, DocumentType[]>();
  const traceIds = new Set<string>();

  for (const row of spanRows) {
    const messageField = row.find(f => f.field === '@message');
    const sessionField = row.find(f => f.field === 'sessionId');
    const traceField = row.find(f => f.field === 'traceId');

    if (!messageField?.value) continue;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(messageField.value) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = sessionField?.value ?? 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, []);
    }
    sessionMap.get(sessionId)!.push(doc as DocumentType);

    if (traceField?.value) {
      traceIds.add(traceField.value);
    }
  }

  if (sessionMap.size === 0) {
    return [];
  }

  // 2. Query runtime logs from the agent's log group for the trace IDs found
  if (traceIds.size > 0) {
    const traceFilter = [...traceIds].map(t => `'${sanitizeQueryValue(t)}'`).join(', ');
    let logRows: ResultField[][] = [];
    try {
      logRows = await executeQuery(
        client,
        runtimeLogGroup,
        `fields @message, traceId
         | filter traceId in [${traceFilter}]
         | sort @timestamp asc
         | limit 10000`,
        startTimeSec,
        endTimeSec
      );
    } catch {
      // Runtime log group may not exist yet; continue with spans only
    }

    const logDocs = extractMessages(logRows);

    // Match runtime logs to sessions via traceId
    // Build traceId → sessionId mapping from spans
    const traceToSession = new Map<string, string>();
    for (const row of spanRows) {
      const traceField = row.find(f => f.field === 'traceId');
      const sessionField = row.find(f => f.field === 'sessionId');
      if (traceField?.value && sessionField?.value) {
        traceToSession.set(traceField.value, sessionField.value);
      }
    }

    for (const logDoc of logDocs) {
      if (!isRelevantForEval(logDoc)) continue;

      const logTraceId = logDoc.traceId as string | undefined;
      const sessionId = logTraceId ? (traceToSession.get(logTraceId) ?? 'unknown') : 'unknown';
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(logDoc as DocumentType);
    }
  }

  // 3. Build session list — aws/spans docs are already scoped by runtimeId (step 1),
  //    and runtime log docs were filtered through isRelevantForEval (step 2).
  //    We keep all docs so the Evaluate API has full trace context for resolving
  //    template variables like {context} and {assistant_turn}.
  const sessions: SessionSpans[] = [];
  for (const [sessionId, docs] of sessionMap) {
    if (docs.length > 0) {
      sessions.push({ sessionId, spans: docs });
    }
  }

  return sessions;
}

export interface RunEvalResult {
  success: boolean;
  error?: string;
  run?: EvalRunResult;
  filePath?: string;
}

export async function handleRunEval(options: RunEvalOptions): Promise<RunEvalResult> {
  let resolution: ResolveResult;

  if (options.agentArn) {
    resolution = resolveFromArn(options);
  } else {
    const context = await loadDeployedProjectConfig();
    resolution = resolveFromProject(context, options);
  }

  if (!resolution.success) {
    return { success: false, error: resolution.error };
  }

  const { ctx } = resolution;

  // Fetch spans grouped by session
  let sessions = await fetchSessionSpans({
    runtimeId: ctx.runtimeId,
    runtimeLogGroup: ctx.runtimeLogGroup,
    region: ctx.region,
    lookbackDays: options.days,
    sessionId: options.sessionId,
    traceId: options.traceId,
  });

  // Filter to selected session IDs if provided (from TUI multi-select)
  if (options.sessionIds && options.sessionIds.length > 0) {
    const selected = new Set(options.sessionIds);
    sessions = sessions.filter(s => selected.has(s.sessionId));
  }

  if (sessions.length === 0) {
    return {
      success: false,
      error: `No session spans found for agent "${ctx.agentLabel}" in the last ${options.days} day(s). Has the agent been invoked?`,
    };
  }

  // Resolve evaluator levels to determine how to send spans
  const evaluatorLevels = await resolveEvaluatorLevels(ctx.evaluatorIds, ctx.region);

  // Build evaluationReferenceInputs if ground truth was provided
  const hasRefInputs =
    (options.assertions?.length ?? 0) > 0 ||
    (options.expectedTrajectory?.length ?? 0) > 0 ||
    !!options.expectedResponse;

  let evaluationReferenceInputs: EvaluationReferenceInput[] | undefined;
  if (hasRefInputs && sessions.length !== 1) {
    return {
      success: false,
      error:
        'Ground truth flags (-A, --expected-trajectory, --expected-response) require exactly one session. Use -s/--session-id to target a single session.',
    };
  }
  if (hasRefInputs) {
    const refInputs: EvaluationReferenceInput[] = [];
    const firstSession = sessions[0]!;

    // Session-level: expectedTrajectory + assertions (one entry per session)
    const sessionRef: EvaluationReferenceInput = {
      context: { spanContext: { sessionId: firstSession.sessionId } },
    };
    let hasSessionRef = false;

    if (options.expectedTrajectory && options.expectedTrajectory.length > 0) {
      sessionRef.expectedTrajectory = { toolNames: options.expectedTrajectory };
      hasSessionRef = true;
    }
    if (options.assertions && options.assertions.length > 0) {
      sessionRef.assertions = options.assertions.map(a => ({ text: a }));
      hasSessionRef = true;
    }
    if (hasSessionRef) {
      refInputs.push(sessionRef);
    }

    // Per-trace: expectedResponse (targets a specific trace)
    if (options.expectedResponse) {
      const traceId = options.traceId ?? extractTraceIds(firstSession.spans).at(-1);
      if (!traceId) {
        return {
          success: false,
          error: 'Expected response provided but no trace IDs found in session spans. Use -t/--trace-id to specify.',
        };
      }
      refInputs.push({
        context: { spanContext: { sessionId: firstSession.sessionId, traceId } },
        expectedResponse: { text: options.expectedResponse },
      });
    }

    if (refInputs.length > 0) {
      evaluationReferenceInputs = refInputs;
    }
  }

  // Run each evaluator against each session with level-appropriate targeting
  const results: EvalEvaluatorResult[] = [];

  for (let i = 0; i < ctx.evaluatorIds.length; i++) {
    const evaluatorId = ctx.evaluatorIds[i]!;
    const evaluatorName = ctx.evaluatorLabels[i] ?? evaluatorId;
    const level = evaluatorLevels.get(evaluatorId) ?? 'SESSION';

    const sessionScores: EvalSessionScore[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;

    for (const session of sessions) {
      // Build evaluation target based on evaluator level
      let targetTraceIds: string[] | undefined;
      let targetSpanIds: string[] | undefined;

      if (level === 'TRACE') {
        targetTraceIds = extractTraceIds(session.spans);
        if (targetTraceIds.length === 0) continue;
      } else if (level === 'TOOL_CALL') {
        targetSpanIds = extractToolCallSpanIds(session.spans);
        if (targetSpanIds.length === 0) continue;
      }

      // The Evaluate API limits targetSpanIds and targetTraceIds to 10 per call.
      // Batch into chunks and merge results.
      const batches = batchTargetIds(targetTraceIds, targetSpanIds);

      for (const batch of batches) {
        const response = await evaluate({
          region: ctx.region,
          evaluatorId,
          sessionSpans: session.spans,
          targetTraceIds: batch.traceIds,
          targetSpanIds: batch.spanIds,
          evaluationReferenceInputs,
        });

        for (const r of response.evaluationResults) {
          sessionScores.push({
            sessionId: r.context?.sessionId ?? session.sessionId,
            traceId: r.context?.traceId,
            spanId: r.context?.spanId,
            value: r.value ?? 0,
            label: r.label,
            explanation: r.explanation,
            errorMessage: r.errorMessage,
          });

          totalInputTokens += r.tokenUsage?.inputTokens ?? 0;
          totalOutputTokens += r.tokenUsage?.outputTokens ?? 0;
          totalTokens += r.tokenUsage?.totalTokens ?? 0;
        }
      }
    }

    const validScores = sessionScores.filter(s => !s.errorMessage);
    const aggregateScore =
      validScores.length > 0 ? validScores.reduce((sum, s) => sum + s.value, 0) / validScores.length : 0;

    results.push({
      evaluator: evaluatorName,
      aggregateScore,
      sessionScores,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens },
    });
  }

  // Build run result
  const timestamp = new Date().toISOString();
  const run: EvalRunResult = {
    timestamp,
    agent: ctx.agentLabel,
    evaluators: ctx.evaluatorLabels,
    lookbackDays: options.days,
    sessionCount: sessions.length,
    results,
    ...(hasRefInputs
      ? {
          referenceInputs: {
            ...(options.assertions?.length ? { assertions: options.assertions } : {}),
            ...(options.expectedTrajectory?.length ? { expectedTrajectory: options.expectedTrajectory } : {}),
            ...(options.expectedResponse ? { expectedResponse: options.expectedResponse } : {}),
          },
        }
      : {}),
  };

  // Save to disk
  let filePath: string;
  if (options.output) {
    writeFileSync(options.output, JSON.stringify(run, null, 2));
    filePath = options.output;
  } else if (options.agentArn) {
    // ARN mode may not have a project directory — save to cwd
    const fallbackPath = join(process.cwd(), `${generateFilename(timestamp)}.json`);
    writeFileSync(fallbackPath, JSON.stringify(run, null, 2));
    filePath = fallbackPath;
  } else {
    filePath = saveEvalRun(run);
  }

  return { success: true, run, filePath };
}
