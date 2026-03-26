import { parseTimeString } from '../../../lib/utils';
import { getOnlineEvaluationConfig } from '../../aws/agentcore-control';
import { searchLogs, streamLogs } from '../../aws/cloudwatch';
import type { DeployedProjectConfig } from '../resolve-agent';
import { loadDeployedProjectConfig, resolveAgent } from '../resolve-agent';

export interface LogsEvalOptions {
  agent?: string;
  since?: string;
  until?: string;
  lines?: string;
  json?: boolean;
  follow?: boolean;
}

export interface LogsEvalResult {
  success: boolean;
  error?: string;
}

function formatLogLine(event: { timestamp: number; message: string }, json: boolean): string {
  if (json) {
    return JSON.stringify({ timestamp: new Date(event.timestamp).toISOString(), message: event.message });
  }
  const ts = new Date(event.timestamp).toISOString();
  return `${ts}  ${event.message}`;
}

interface ResolvedLogGroup {
  logGroupName: string;
  configName: string;
  failureReason?: string;
}

/**
 * Resolve the online eval config log group names.
 * Fetches the actual log group from the API when possible, falls back to convention.
 */
async function resolveEvalLogGroups(
  context: DeployedProjectConfig,
  targetName: string,
  region: string
): Promise<ResolvedLogGroup[]> {
  const { project, deployedState } = context;
  const targetResources = deployedState.targets[targetName]?.resources;

  const matchingConfigs = project.onlineEvalConfigs ?? [];

  const results: ResolvedLogGroup[] = [];
  for (const config of matchingConfigs) {
    const deployed = targetResources?.onlineEvalConfigs?.[config.name];
    if (!deployed?.onlineEvaluationConfigId) continue;

    const configId = deployed.onlineEvaluationConfigId;
    const fallbackLogGroup = `/aws/bedrock-agentcore/evaluations/results/${configId}`;

    try {
      const apiConfig = await getOnlineEvaluationConfig({ region, configId });
      results.push({
        logGroupName: apiConfig.outputLogGroupName ?? fallbackLogGroup,
        configName: config.name,
        failureReason: apiConfig.failureReason,
      });
    } catch {
      // API call failed — fall back to convention-based name
      results.push({ logGroupName: fallbackLogGroup, configName: config.name });
    }
  }

  return results;
}

export async function handleLogsEval(options: LogsEvalOptions): Promise<LogsEvalResult> {
  const context = await loadDeployedProjectConfig();
  const agentResult = resolveAgent(context, { agent: options.agent });

  if (!agentResult.success) {
    return { success: false, error: agentResult.error };
  }

  const { agent } = agentResult;

  const resolvedLogGroups = await resolveEvalLogGroups(context, agent.targetName, agent.region);

  if (resolvedLogGroups.length === 0) {
    return {
      success: false,
      error: `No deployed online eval configs found. Add one with 'agentcore add online-eval' and deploy.`,
    };
  }

  // Surface failure reasons from configs that are in a failed state
  for (const lg of resolvedLogGroups) {
    if (lg.failureReason) {
      console.error(`Warning: Online eval config '${lg.configName}' has a failure: ${lg.failureReason}`);
    }
  }

  const isJson = options.json ?? false;
  const isFollow = options.follow ?? (!options.since && !options.until);

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);

  try {
    // Query all matching log groups
    for (const { logGroupName } of resolvedLogGroups) {
      if (!isFollow) {
        const startTimeMs = options.since ? parseTimeString(options.since) : Date.now() - 3_600_000;
        const endTimeMs = options.until ? parseTimeString(options.until) : Date.now();
        const limit = options.lines ? parseInt(options.lines, 10) : undefined;

        try {
          for await (const event of searchLogs({
            logGroupName,
            region: agent.region,
            startTimeMs,
            endTimeMs,
            limit,
          })) {
            console.log(formatLogLine(event, isJson));
          }
        } catch (err: unknown) {
          const errorName = (err as { name?: string })?.name;
          if (errorName === 'ResourceNotFoundException') {
            // Log group exists in config but not yet in CloudWatch — skip
            continue;
          }
          throw err;
        }
      } else {
        console.error(`Streaming eval logs for ${agent.agentName} from ${logGroupName}... (Ctrl+C to stop)`);

        try {
          for await (const event of streamLogs({
            logGroupName,
            region: agent.region,
            accountId: agent.accountId,
            abortSignal: ac.signal,
          })) {
            console.log(formatLogLine(event, isJson));
          }
        } catch (err: unknown) {
          const errorName = (err as { name?: string })?.name;
          if (errorName === 'ResourceNotFoundException') {
            console.error(`Log group ${logGroupName} not found yet — waiting for online eval results...`);
            continue;
          }
          throw err;
        }
      }
    }

    return { success: true };
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;

    if (errorName === 'AbortError' || ac.signal.aborted) {
      return { success: true };
    }

    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
  }
}
