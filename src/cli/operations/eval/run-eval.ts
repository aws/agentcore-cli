import { ConfigIO, ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { getCredentialProvider } from '../../aws';
import type { EvaluationReferenceInput } from '../../aws/agentcore';
import { getEvaluator } from '../../aws/agentcore-control';
import { runtimeLogGroup } from '../../aws/cloudwatch';
import { resolveAgentContext } from '../invoke/resolve-agent-context';
import type { DeployedProjectConfig } from '../resolve-agent';
import { loadDeployedProjectConfig, resolveAgent } from '../resolve-agent';
import { runDatasetScenariosAndCollectSpans } from './shared/dataset-session-provider';
import { runEvaluatorsOverSessions } from './shared/evaluator-runner';
import {
  SPANS_LOG_GROUP,
  executeQuery,
  extractTraceIds,
  fetchSessionSpans,
  sanitizeQueryValue,
} from './shared/span-collector';
import { generateFilename, saveEvalRun } from './storage';
import type { EvalRunResult, RunEvalOptions, SessionInfo } from './types';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { writeFileSync } from 'fs';
import { join } from 'path';

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

  return {
    success: true,
    ctx: {
      agentLabel: runtimeId,
      region,
      runtimeId,
      runtimeLogGroup: runtimeLogGroup(runtimeId, options.endpoint),
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
      runtimeLogGroup: runtimeLogGroup(agent.runtimeId, options.endpoint),
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

export type RunEvalResult = Result<{ run: EvalRunResult; filePath: string }>;

export async function handleRunEval(options: RunEvalOptions): Promise<RunEvalResult> {
  let resolution: ResolveResult;

  if (options.agentArn) {
    resolution = resolveFromArn(options);
  } else {
    const context = await loadDeployedProjectConfig();
    resolution = resolveFromProject(context, options);
  }

  if (!resolution.success) {
    return { success: false, error: new ResourceNotFoundError(resolution.error) };
  }

  const { ctx } = resolution;

  // Dataset mode: invoke agent with scenarios, collect spans, build ground truth
  if (options.dataset) {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    const deployedState = await configIO.readDeployedState();
    const awsTargets = await configIO.readAWSDeploymentTargets();

    const agentContext = await resolveAgentContext({
      project,
      deployedState,
      awsTargets,
      agentName: options.agent,
      endpoint: options.endpoint,
    });

    const datasetResult = await runDatasetScenariosAndCollectSpans({
      agentContext,
      datasetName: options.dataset,
      version: options.datasetVersion,
      configBaseDir: configIO.getConfigRoot(),
      querySpans: async (region, logGroup, sessionId) => {
        const result = await fetchSessionSpans({
          runtimeId: agentContext.runtimeId,
          runtimeLogGroup: logGroup,
          region,
          lookbackDays: 1,
          sessionId,
        });
        return result.length > 0 ? result[0]!.spans : [];
      },
      onProgress: options.onProgress,
    });

    if (datasetResult.sessions.length === 0) {
      return {
        success: false,
        error: new ResourceNotFoundError('No spans collected from dataset scenarios. All sessions may have timed out.'),
      };
    }

    // Resolve evaluator levels
    const evaluatorLevels = await resolveEvaluatorLevels(ctx.evaluatorIds, ctx.region);

    // Group dataset-generated ref inputs by sessionId
    const refInputsBySession = new Map<string, EvaluationReferenceInput[]>();
    for (const ref of datasetResult.referenceInputs) {
      const sid = ref.context.spanContext.sessionId;
      const list = refInputsBySession.get(sid) ?? [];
      list.push(ref);
      refInputsBySession.set(sid, list);
    }

    // Tag sessions with scenarioId
    const scenarioBySession = new Map(datasetResult.scenarioResults.map(r => [r.sessionId, r.scenarioId]));
    const sessions = datasetResult.sessions.map(s => ({
      sessionId: s.sessionId,
      spans: s.spans,
      scenarioId: scenarioBySession.get(s.sessionId),
    }));

    const results = await runEvaluatorsOverSessions({
      region: ctx.region,
      evaluatorIds: ctx.evaluatorIds,
      evaluatorLabels: ctx.evaluatorLabels,
      evaluatorLevels,
      sessions,
      refInputsBySession,
    });

    // Build and save result
    const timestamp = new Date().toISOString();
    const run: EvalRunResult = {
      timestamp,
      agent: ctx.agentLabel,
      evaluators: ctx.evaluatorLabels,
      sessionCount: sessions.length,
      results,
      source: 'dataset',
      datasetName: options.dataset,
      dataset: {
        id: options.dataset,
        version: options.datasetVersion ?? 'LOCAL',
      },
    };

    const filePath = options.output ?? saveEvalRun(run);

    return { success: true, run, filePath };
  }

  // Historical trace mode (existing behavior)
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
      error: new ResourceNotFoundError(
        `No session spans found for agent "${ctx.agentLabel}" in the last ${options.days} day(s). Has the agent been invoked?`
      ),
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
      error: new ValidationError(
        'Ground truth flags (-A, --expected-trajectory, --expected-response) require exactly one session. Use -s/--session-id to target a single session.'
      ),
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
          error: new ValidationError(
            'Expected response provided but no trace IDs found in session spans. Use -t/--trace-id to specify.'
          ),
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

  // Historical mode: one set of ref inputs applies to the single targeted session
  const refInputsBySession = evaluationReferenceInputs
    ? new Map([[sessions[0]!.sessionId, evaluationReferenceInputs]])
    : undefined;

  const results = await runEvaluatorsOverSessions({
    region: ctx.region,
    evaluatorIds: ctx.evaluatorIds,
    evaluatorLabels: ctx.evaluatorLabels,
    evaluatorLevels,
    sessions,
    refInputsBySession,
  });

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
