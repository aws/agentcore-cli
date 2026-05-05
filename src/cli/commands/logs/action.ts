import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { parseTimeString } from '../../../lib/utils';
import { searchLogs, streamLogs } from '../../aws/cloudwatch';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import type { DeployedProjectConfig } from '../../operations/resolve-agent';
import { loadDeployedProjectConfig, resolveAgent } from '../../operations/resolve-agent';
import { VALID_LEVELS, buildFilterPattern } from './filter-pattern';
import type { LogsOptions } from './types';

export type { DeployedProjectConfig };

export interface AgentContext {
  agentId: string;
  agentName: string;
  accountId: string;
  region: string;
  endpointName: string;
  logGroupName: string;
}

/**
 * Detect whether to stream or search based on options
 */
export function detectMode(options: LogsOptions): 'stream' | 'search' {
  if (options.since || options.until) {
    return 'search';
  }
  return 'stream';
}

/**
 * Format a log event for display
 */
export function formatLogLine(event: { timestamp: number; message: string }, json: boolean): string {
  if (json) {
    return JSON.stringify({ timestamp: new Date(event.timestamp).toISOString(), message: event.message });
  }
  const ts = new Date(event.timestamp).toISOString();
  return `${ts}  ${event.message}`;
}

/**
 * Resolve agent context from config + options
 */
export function resolveAgentContext(
  context: DeployedProjectConfig,
  options: LogsOptions
): Result<{ agentContext: AgentContext }> {
  const result = resolveAgent(context, options);
  if (!result.success) {
    return { success: false, error: new ResourceNotFoundError(result.error) };
  }
  const { agent } = result;
  const endpointName = DEFAULT_ENDPOINT_NAME;
  const logGroupName = `/aws/bedrock-agentcore/runtimes/${agent.runtimeId}-${endpointName}`;
  return {
    success: true,
    agentContext: {
      agentId: agent.runtimeId,
      agentName: agent.agentName,
      accountId: agent.accountId,
      region: agent.region,
      endpointName,
      logGroupName,
    },
  };
}

/**
 * Main logs handler
 */
export async function handleLogs(options: LogsOptions): Promise<Result> {
  // Validate level early
  if (options.level && !VALID_LEVELS.includes(options.level.toLowerCase())) {
    return {
      success: false,
      error: new ValidationError(`Invalid log level: "${options.level}". Valid levels: ${VALID_LEVELS.join(', ')}`),
    };
  }

  const context = await loadDeployedProjectConfig();
  const resolution = resolveAgentContext(context, options);

  if (!resolution.success) {
    return { success: false, error: resolution.error };
  }

  const { agentContext } = resolution;

  // Build filter pattern
  let filterPattern: string | undefined;
  try {
    filterPattern = buildFilterPattern({ level: options.level, query: options.query });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  const mode = detectMode(options);
  const isJson = options.json ?? false;

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);

  try {
    if (mode === 'search') {
      const startTimeMs = options.since ? parseTimeString(options.since) : Date.now() - 3_600_000;
      const endTimeMs = options.until ? parseTimeString(options.until) : Date.now();
      const limit = options.limit ? parseInt(options.limit, 10) : undefined;

      for await (const event of searchLogs({
        logGroupName: agentContext.logGroupName,
        region: agentContext.region,
        startTimeMs,
        endTimeMs,
        filterPattern,
        limit,
      })) {
        console.log(formatLogLine(event, isJson));
      }
    } else {
      console.error(`Streaming logs for ${agentContext.agentName}... (Ctrl+C to stop)`);

      for await (const event of streamLogs({
        logGroupName: agentContext.logGroupName,
        region: agentContext.region,
        accountId: agentContext.accountId,
        filterPattern,
        abortSignal: ac.signal,
      })) {
        console.log(formatLogLine(event, isJson));
      }
    }

    return { success: true };
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;

    if (errorName === 'ResourceNotFoundException') {
      return {
        success: false,
        error: new ResourceNotFoundError(
          `No logs found for agent '${agentContext.agentName}'. Has the agent been invoked?`
        ),
      };
    }

    if (errorName === 'AbortError' || ac.signal.aborted) {
      return { success: true };
    }

    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
  }
}
