import { parseTimeString } from '../../../lib/utils';
import type { DeployedProjectConfig } from '../../operations/resolve-agent';
import { resolveAgent } from '../../operations/resolve-agent';
import { buildTraceConsoleUrl, getTrace, listTraces } from '../../operations/traces';
import type { TracesGetOptions, TracesListOptions } from './types';

export interface TracesListResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  consoleUrl?: string;
  traces?: { traceId: string; timestamp: string; sessionId?: string }[];
  error?: string;
}

export async function handleTracesList(
  context: DeployedProjectConfig,
  options: TracesListOptions
): Promise<TracesListResult> {
  const resolved = resolveAgent(context, options);
  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }

  const { agent } = resolved;

  const consoleUrl = buildTraceConsoleUrl({
    region: agent.region,
    accountId: agent.accountId,
    runtimeId: agent.runtimeId,
    agentName: agent.agentName,
  });

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  if (isNaN(limit)) {
    return { success: false, error: '--limit must be a number' };
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

export interface TracesGetResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  consoleUrl?: string;
  filePath?: string;
  error?: string;
}

export async function handleTracesGet(
  context: DeployedProjectConfig,
  traceId: string,
  options: TracesGetOptions
): Promise<TracesGetResult> {
  const resolved = resolveAgent(context, options);
  if (!resolved.success) {
    return { success: false, error: resolved.error };
  }

  const { agent } = resolved;

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
