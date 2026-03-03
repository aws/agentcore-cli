import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { searchLogs, streamLogs } from '../../aws/cloudwatch';
import { VALID_LEVELS, buildFilterPattern } from './filter-pattern';
import { parseTimeString } from './time-parser';
import type { LogsOptions } from './types';

export interface LogsContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

export interface AgentContext {
  agentId: string;
  agentName: string;
  accountId: string;
  region: string;
  endpointName: string;
  logGroupName: string;
}

export interface LogsResult {
  success: boolean;
  error?: string;
}

/**
 * Loads configuration required for logs
 */
export async function loadLogsConfig(configIO: ConfigIO = new ConfigIO()): Promise<LogsContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
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
  context: LogsContext,
  options: LogsOptions
): { success: true; agentContext: AgentContext } | { success: false; error: string } {
  const { project, deployedState, awsTargets } = context;

  if (project.agents.length === 0) {
    return { success: false, error: 'No agents defined in agentcore.json' };
  }

  // Resolve agent
  const agentNames = project.agents.map(a => a.name);

  if (!options.agent && project.agents.length > 1) {
    return {
      success: false,
      error: `Multiple agents found. Use --agent to specify one: ${agentNames.join(', ')}`,
    };
  }

  const agentSpec = options.agent ? project.agents.find(a => a.name === options.agent) : project.agents[0];

  if (options.agent && !agentSpec) {
    return {
      success: false,
      error: `Agent '${options.agent}' not found. Available: ${agentNames.join(', ')}`,
    };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in agentcore.json' };
  }

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }
  const selectedTargetName = targetNames[0]!;

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.agents?.[agentSpec.name];

  if (!agentState) {
    return {
      success: false,
      error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'. Run 'agentcore deploy' first.`,
    };
  }

  const agentId = agentState.runtimeId;
  const endpointName = 'DEFAULT';
  const logGroupName = `/aws/bedrock-agentcore/runtimes/${agentId}-${endpointName}`;

  return {
    success: true,
    agentContext: {
      agentId,
      agentName: agentSpec.name,
      accountId: targetConfig.account,
      region: targetConfig.region,
      endpointName,
      logGroupName,
    },
  };
}

/**
 * Main logs handler
 */
export async function handleLogs(options: LogsOptions): Promise<LogsResult> {
  // Validate level early
  if (options.level && !VALID_LEVELS.includes(options.level.toLowerCase())) {
    return {
      success: false,
      error: `Invalid log level: "${options.level}". Valid levels: ${VALID_LEVELS.join(', ')}`,
    };
  }

  const context = await loadLogsConfig();
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
    return { success: false, error: (err as Error).message };
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
      const limit = options.lines ? parseInt(options.lines, 10) : undefined;

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
        error: `No logs found for agent '${agentContext.agentName}'. Has the agent been invoked?`,
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
