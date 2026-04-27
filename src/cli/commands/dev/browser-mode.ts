import { ConfigIO, findConfigRoot, getWorkingDirectory } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { getDevConfig, getDevSupportedAgents, loadDevEnv, loadProjectConfig } from '../../operations/dev';
import { type OtelCollector, startOtelCollector } from '../../operations/dev/otel';
import {
  type AgentInfo,
  type ListMemoryRecordsHandler,
  type RetrieveMemoryRecordsHandler,
  runWebUI,
} from '../../operations/dev/web-ui';
import { listMemoryRecords, retrieveMemoryRecords } from '../../operations/memory';
import path from 'node:path';

interface DeployedHandlers {
  onListMemoryRecords?: ListMemoryRecordsHandler;
  onRetrieveMemoryRecords?: RetrieveMemoryRecordsHandler;
}

/**
 * Resolve deployed resources (memories, agents) from config and return handlers
 * that query them via the AWS SDK. Only resources with "deployed" status are available.
 */
async function resolveDeployedHandlers(
  baseDir: string,
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void
): Promise<DeployedHandlers> {
  const configIO = new ConfigIO({ baseDir });

  if (!configIO.configExists('state') || !configIO.configExists('awsTargets')) {
    return {};
  }

  try {
    const deployedState = await configIO.readDeployedState();
    const awsTargets = await configIO.readAWSDeploymentTargets();

    const targetName = Object.keys(deployedState.targets)[0];
    if (!targetName) return {};

    const targetState = deployedState.targets[targetName];
    const targetConfig = awsTargets.find(t => t.name === targetName);
    if (!targetConfig) return {};

    const region = targetConfig.region;
    const result: DeployedHandlers = {};

    // Memory handlers
    const memoryEntries = targetState?.resources?.memories ?? {};
    const memories = Object.entries(memoryEntries).map(([name, state]) => ({
      name,
      memoryId: state.memoryId,
      region,
    }));

    if (memories.length > 0) {
      onLog(
        'info',
        `Memory browsing enabled for ${memories.length} deployed memory(ies): ${memories.map(m => m.name).join(', ')}`
      );

      result.onListMemoryRecords = async (memoryName, namespace, strategyId) => {
        const memory = memories.find(m => m.name === memoryName);
        if (!memory) return { success: false, error: `Memory "${memoryName}" not found in deployed state` };
        return listMemoryRecords({
          region: memory.region,
          memoryId: memory.memoryId,
          namespace,
          memoryStrategyId: strategyId,
        });
      };

      result.onRetrieveMemoryRecords = async (memoryName, namespace, searchQuery, strategyId) => {
        const memory = memories.find(m => m.name === memoryName);
        if (!memory) return { success: false, error: `Memory "${memoryName}" not found in deployed state` };
        return retrieveMemoryRecords({
          region: memory.region,
          memoryId: memory.memoryId,
          namespace,
          searchQuery,
          memoryStrategyId: strategyId,
        });
      };
    }

    return result;
  } catch (err) {
    onLog('warn', `Could not resolve deployed resources: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export interface BrowserModeOptions {
  workingDir: string;
  project: AgentCoreProjectSpec;
  port: number;
  agentName?: string;
  /** OTEL env vars to pass to dev servers (set by the dev command when collector is active) */
  otelEnvVars?: Record<string, string>;
  /** OTEL collector instance for local trace collection */
  collector?: OtelCollector;
}

/**
 * Standalone entry point for launching browser dev mode from the TUI.
 * Handles all setup (project loading, OTEL collector, etc.) internally.
 */
export async function launchBrowserDev(): Promise<void> {
  const workingDir = getWorkingDirectory();
  const project = await loadProjectConfig(workingDir);

  if (!project?.runtimes || project.runtimes.length === 0) {
    console.error('Error: No agents defined in project.');
    process.exit(1);
  }

  const configRoot = findConfigRoot(workingDir);
  const persistTracesDir = path.join(configRoot ?? workingDir, '.cli', 'traces');
  const { collector, otelEnvVars } = await startOtelCollector(persistTracesDir);

  await runBrowserMode({
    workingDir,
    project,
    port: 8080,
    otelEnvVars,
    collector,
  });
}

export async function runBrowserMode(opts: BrowserModeOptions): Promise<void> {
  const { workingDir, project, agentName, otelEnvVars = {}, collector } = opts;

  const configRoot = findConfigRoot(workingDir);
  const { envVars } = await loadDevEnv(workingDir);

  const supportedAgents = getDevSupportedAgents(project);

  if (supportedAgents.length === 0) {
    console.error('Error: No dev-supported agents found.');
    process.exit(1);
  }

  if (agentName && !supportedAgents.some(a => a.name === agentName)) {
    console.error(`Error: Agent "${agentName}" not found or does not support dev mode.`);
    process.exit(1);
  }

  const onLog = (level: 'info' | 'warn' | 'error', msg: string) => {
    if (level === 'error') console.error(`Web UI: ${msg}`);
  };

  const mergedEnvVars = { ...envVars, ...otelEnvVars };

  const agentInfoList: AgentInfo[] = supportedAgents.map(a => ({
    name: a.name,
    buildType: a.build,
    protocol: a.protocol ?? 'HTTP',
  }));

  // Resolve deployed resources (memories, agents) so memory browsing and
  // CloudWatch traces work in dev mode alongside local traces.
  // Handlers re-resolve on each call so newly deployed memories are picked up.
  const baseDir = configRoot ?? workingDir;

  await runWebUI({
    logLabel: 'dev',
    onLog,
    serverOptions: {
      mode: 'dev',
      agents: agentInfoList,
      selectedAgent: agentName,
      envVars: mergedEnvVars,
      getEnvVars: async () => {
        const { envVars: freshEnvVars } = await loadDevEnv(workingDir);
        return { ...freshEnvVars, ...otelEnvVars };
      },
      configRoot: configRoot ?? undefined,
      getDevConfig: async name => {
        const freshProject = await loadProjectConfig(workingDir);
        return getDevConfig(workingDir, freshProject, configRoot ?? undefined, name);
      },
      reloadAgents: configRoot
        ? async () => {
            const freshProject = await loadProjectConfig(workingDir);
            return getDevSupportedAgents(freshProject).map(a => ({
              name: a.name,
              buildType: a.build,
              protocol: a.protocol ?? 'HTTP',
            }));
          }
        : undefined,
      onListTraces: collector
        ? (agentNameParam, startTime, endTime) => collector.listTraces(agentNameParam, startTime, endTime)
        : undefined,
      onGetTrace: collector ? (agentNameParam, traceId) => collector.getTraceSpans(agentNameParam, traceId) : undefined,
      onListMemoryRecords: async (memoryName, namespace, strategyId) => {
        const deployed = await resolveDeployedHandlers(baseDir, onLog);
        if (!deployed.onListMemoryRecords) return { success: false, error: 'No deployed AgentCore Memory found' };
        return deployed.onListMemoryRecords(memoryName, namespace, strategyId);
      },
      onRetrieveMemoryRecords: async (memoryName, namespace, searchQuery, strategyId) => {
        const deployed = await resolveDeployedHandlers(baseDir, onLog);
        if (!deployed.onRetrieveMemoryRecords) return { success: false, error: 'No deployed AgentCore Memory found' };
        return deployed.onRetrieveMemoryRecords(memoryName, namespace, searchQuery, strategyId);
      },
    },
  });
}
