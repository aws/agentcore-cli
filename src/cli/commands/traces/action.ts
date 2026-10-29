import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { parseTimeString } from '../../../lib/utils';
import type { DeployedProjectConfig } from '../../operations/resolve-agent';
import { resolveAgent } from '../../operations/resolve-agent';
import { buildTraceConsoleUrl, compareTraces, getTrace, listTraces } from '../../operations/traces';
import type { TraceComparisonDeltas, TraceMetrics } from '../../operations/traces';
import type { TracesCompareOptions, TracesGetOptions, TracesListOptions } from './types';

/** Traces are only supported for Python agents. */
function requirePythonRuntime(context: DeployedProjectConfig, agentName: string): ValidationError | undefined {
  const runtimeSpec = context.project.runtimes.find(r => r.name === agentName);
  const isPython =
    (runtimeSpec?.entrypoint?.endsWith('.py') ?? false) || (runtimeSpec?.entrypoint?.includes('.py:') ?? false);
  if (!isPython) {
    return new ValidationError(
      'Traces are only supported for Python agents. TypeScript agents do not support observability traces.'
    );
  }
  return undefined;
}

export type TracesListResult = Result<{
  agentName?: string;
  targetName?: string;
  traces: { traceId: string; timestamp: string; sessionId?: string }[];
}> & { consoleUrl?: string };

export async function handleTracesList(
  context: DeployedProjectConfig,
  options: TracesListOptions
): Promise<TracesListResult> {
  const resolved = resolveAgent(context, options);
  if (!resolved.success) {
    return { success: false, error: new ResourceNotFoundError(resolved.error) };
  }

  const { agent } = resolved;

  const pythonError = requirePythonRuntime(context, agent.agentName);
  if (pythonError) {
    return { success: false, error: pythonError };
  }

  const consoleUrl = buildTraceConsoleUrl({
    region: agent.region,
    accountId: agent.accountId,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
  });

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  if (isNaN(limit)) {
    return { success: false, error: new ValidationError('--limit must be a number') };
  }

  // Parse time options
  let startTime: number | undefined;
  let endTime: number | undefined;
  if (options.since) {
    startTime = parseTimeString(options.since);
  }
  if (options.until) {
    endTime = parseTimeString(options.until);
  }

  const result = await listTraces({
    region: agent.region,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
    limit,
    startTime,
    endTime,
  });

  if (!result.success) {
    return { success: false, error: result.error, consoleUrl };
  }

  return {
    success: true,
    agentName: agent.agentName,
    targetName: agent.targetName,
    consoleUrl,
    traces: result.traces,
  };
}

export type TracesGetResult = Result<{
  agentName?: string;
  targetName?: string;
  filePath?: string;
}> & { consoleUrl?: string };

export async function handleTracesGet(
  context: DeployedProjectConfig,
  traceId: string,
  options: TracesGetOptions
): Promise<TracesGetResult> {
  const resolved = resolveAgent(context, options);
  if (!resolved.success) {
    return { success: false, error: new ResourceNotFoundError(resolved.error) };
  }

  const { agent } = resolved;

  const pythonError = requirePythonRuntime(context, agent.agentName);
  if (pythonError) {
    return { success: false, error: pythonError };
  }

  const consoleUrl = buildTraceConsoleUrl({
    region: agent.region,
    accountId: agent.accountId,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
  });

  // Parse time options
  let startTime: number | undefined;
  let endTime: number | undefined;
  if (options.since) {
    startTime = parseTimeString(options.since);
  }
  if (options.until) {
    endTime = parseTimeString(options.until);
  }

  const result = await getTrace({
    region: agent.region,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
    traceId,
    outputPath: options.output,
    startTime,
    endTime,
  });

  if (!result.success) {
    return { success: false, error: result.error, consoleUrl };
  }

  return {
    success: true,
    agentName: agent.agentName,
    targetName: agent.targetName,
    consoleUrl,
    filePath: result.filePath,
  };
}

export type TracesCompareResult = Result<{
  agentName?: string;
  targetName?: string;
  baseline: TraceMetrics;
  candidate: TraceMetrics;
  deltas: TraceComparisonDeltas;
  warnings: string[];
}> & { consoleUrl?: string };

export async function handleTracesCompare(
  context: DeployedProjectConfig,
  baselineTraceId: string,
  candidateTraceId: string,
  options: TracesCompareOptions
): Promise<TracesCompareResult> {
  const resolved = resolveAgent(context, options);
  if (!resolved.success) {
    return { success: false, error: new ResourceNotFoundError(resolved.error) };
  }

  const { agent } = resolved;

  const pythonError = requirePythonRuntime(context, agent.agentName);
  if (pythonError) {
    return { success: false, error: pythonError };
  }

  const consoleUrl = buildTraceConsoleUrl({
    region: agent.region,
    accountId: agent.accountId,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
  });

  // Parse time options
  let startTime: number | undefined;
  let endTime: number | undefined;
  if (options.since) {
    startTime = parseTimeString(options.since);
  }
  if (options.until) {
    endTime = parseTimeString(options.until);
  }

  const result = await compareTraces({
    region: agent.region,
    runtimeId: agent.runtimeId,
    baselineTraceId,
    candidateTraceId,
    startTime,
    endTime,
  });

  if (!result.success) {
    return { success: false, error: result.error, consoleUrl };
  }

  return {
    success: true,
    agentName: agent.agentName,
    targetName: agent.targetName,
    consoleUrl,
    baseline: result.baseline,
    candidate: result.candidate,
    deltas: result.deltas,
    warnings: result.warnings,
  };
}
