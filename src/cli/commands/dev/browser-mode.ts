import { ConfigIO, findConfigRoot, getWorkingDirectory } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { ANSI } from '../../constants';
import { isPreviewEnabled } from '../../feature-flags';
import { getDevConfig, getDevSupportedAgents, loadDevEnv, loadProjectConfig } from '../../operations/dev';
import { type OtelCollector, startOtelCollector } from '../../operations/dev/otel';
import {
  type AgentInfo,
  type ListMemoryRecordsHandler,
  type RetrieveMemoryRecordsHandler,
  runWebUI,
} from '../../operations/dev/web-ui';
import type { HarnessInfo } from '../../operations/dev/web-ui/constants';
import { listMemoryRecords, retrieveMemoryRecords } from '../../operations/memory';
import { loadDeployedProjectConfig, resolveAgentOrHarness } from '../../operations/resolve-agent';
import { fetchTraceRecords, listTraces } from '../../operations/traces';
import { LayoutProvider } from '../../tui/context';
import { runCliDeploy } from '../deploy/progress';
import { render } from 'ink';
import path from 'node:path';
import React from 'react';

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

      result.onListMemoryRecords = async args => {
        const memory = memories.find(m => m.name === args.memoryName);
        if (!memory) return { success: false, error: `Memory "${args.memoryName}" not found in deployed state` };
        const res = await listMemoryRecords({
          region: memory.region,
          memoryId: memory.memoryId,
          memoryStrategyId: args.strategyId,
          ...(args.namespace ? { namespace: args.namespace } : { namespacePath: args.namespacePath! }),
        });
        return res.success ? res : { success: false as const, error: res.error.message };
      };

      result.onRetrieveMemoryRecords = async args => {
        const memory = memories.find(m => m.name === args.memoryName);
        if (!memory) return { success: false, error: `Memory "${args.memoryName}" not found in deployed state` };
        const res = await retrieveMemoryRecords({
          region: memory.region,
          memoryId: memory.memoryId,
          searchQuery: args.searchQuery,
          memoryStrategyId: args.strategyId,
          ...(args.namespace ? { namespace: args.namespace } : { namespacePath: args.namespacePath! }),
        });
        return res.success ? res : { success: false as const, error: res.error.message };
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
  harnessName?: string;
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

  if (!project) {
    console.error('Error: No agents or harnesses defined in project.');
    process.exit(1);
  }

  const hasRuntimes = project.runtimes.length > 0;
  const hasHarnesses = isPreviewEnabled() && (project.harnesses ?? []).length > 0;

  if (!hasRuntimes && !hasHarnesses) {
    console.error('Error: No agents or harnesses defined in project.');
    process.exit(1);
  }

  if (hasHarnesses) {
    await runCliDeploy();
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
  const { workingDir, project, agentName, harnessName, otelEnvVars = {}, collector } = opts;

  const configRoot = findConfigRoot(workingDir);
  // Browser mode serves multiple agents; we don't know which agent will be
  // launched until the user picks one in the web UI. Pass no runtime so
  // payment env vars are emitted for any deployed manager and the spawned
  // agent decides whether to consume them. Single-agent CLI dev correctly
  // narrows by runtime via loadDevEnv(workingDir, runtime) elsewhere.
  const { envVars } = await loadDevEnv(workingDir);

  const supportedAgents = getDevSupportedAgents(project);
  const projectHasHarnesses = isPreviewEnabled() && (project.harnesses ?? []).length > 0;

  if (supportedAgents.length === 0 && !projectHasHarnesses) {
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

  // Discover deployed harnesses from project config + deployed state (preview mode)
  const harnessInfoList: HarnessInfo[] = [];
  if (isPreviewEnabled()) {
    try {
      const configIO = new ConfigIO({ baseDir });
      if (configIO.configExists('state') && configIO.configExists('awsTargets')) {
        const deployedState = await configIO.readDeployedState();
        const awsTargets = await configIO.readAWSDeploymentTargets();
        const targetName = Object.keys(deployedState.targets)[0];
        if (targetName) {
          const targetState = deployedState.targets[targetName];
          const targetConfig = awsTargets.find(t => t.name === targetName);
          if (targetConfig) {
            for (const harness of project.harnesses ?? []) {
              const state = targetState?.resources?.harnesses?.[harness.name];
              if (state) {
                harnessInfoList.push({
                  name: harness.name,
                  harnessArn: state.harnessArn,
                  region: targetConfig.region,
                });
              }
            }
            if (harnessInfoList.length > 0) {
              onLog(
                'info',
                `Found ${harnessInfoList.length} deployed harness(es): ${harnessInfoList.map(h => h.name).join(', ')}`
              );
            }
          }
        }
      }
    } catch {
      // Harness discovery is best-effort — local dev works without it
    }
  }

  await runWebUI({
    logLabel: 'dev',
    onLog,
    serverOptions: {
      mode: 'dev',
      agents: agentInfoList,
      harnesses: harnessInfoList,
      selectedAgent: agentName,
      selectedHarness: harnessName,
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
      onListCloudWatchTraces: async (agentName, harnessName, startTime, endTime) => {
        try {
          const configIO = new ConfigIO({ baseDir });
          const context = await loadDeployedProjectConfig(configIO);
          const resolved = await resolveAgentOrHarness(context, { runtime: agentName, harness: harnessName });
          if (!resolved.success) return { success: false, error: resolved.error };
          const res = await listTraces({
            region: resolved.agent.region,
            runtimeId: resolved.agent.runtimeId,
            agentName: resolved.agent.agentName,
            startTime,
            endTime,
          });
          return res.success ? res : { success: false as const, error: res.error.message };
        } catch (err) {
          return {
            success: false,
            error: `Failed to list CloudWatch traces: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      onGetCloudWatchTrace: async (agentName, harnessName, traceId, startTime, endTime) => {
        try {
          const configIO = new ConfigIO({ baseDir });
          const context = await loadDeployedProjectConfig(configIO);
          const resolved = await resolveAgentOrHarness(context, { runtime: agentName, harness: harnessName });
          if (!resolved.success) return { success: false, error: resolved.error };
          const res = await fetchTraceRecords({
            region: resolved.agent.region,
            runtimeId: resolved.agent.runtimeId,
            traceId,
            startTime,
            endTime,
            includeSpans: true,
          });
          return res.success ? res : { success: false as const, error: res.error.message };
        } catch (err) {
          return {
            success: false,
            error: `Failed to get CloudWatch trace: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      onListMemoryRecords: async args => {
        const deployed = await resolveDeployedHandlers(baseDir, onLog);
        if (!deployed.onListMemoryRecords) return { success: false, error: 'No deployed AgentCore Memory found' };
        return deployed.onListMemoryRecords(args);
      },
      onRetrieveMemoryRecords: async args => {
        const deployed = await resolveDeployedHandlers(baseDir, onLog);
        if (!deployed.onRetrieveMemoryRecords) return { success: false, error: 'No deployed AgentCore Memory found' };
        return deployed.onRetrieveMemoryRecords(args);
      },
    },
  });
}

const { enterAltScreen: ENTER_ALT_SCREEN, exitAltScreen: EXIT_ALT_SCREEN, showCursor: SHOW_CURSOR } = ANSI;

interface TuiPickerResult {
  agentName?: string;
  harnessName?: string;
}

export async function launchTuiDevScreenWithPicker(
  workingDir: string,
  options?: { skipDeploy?: boolean }
): Promise<TuiPickerResult | undefined> {
  process.stdout.write(ENTER_ALT_SCREEN);

  const exitAltScreen = () => {
    process.stdout.write(EXIT_ALT_SCREEN);
    process.stdout.write(SHOW_CURSOR);
  };

  let pickerResult: TuiPickerResult | undefined;
  const { DevScreen } = await import('../../tui/screens/dev/DevScreen');
  const { unmount, waitUntilExit } = render(
    React.createElement(
      LayoutProvider,
      null,
      React.createElement(DevScreen, {
        onBack: () => {
          exitAltScreen();
          unmount();
          process.exit(0);
        },
        workingDir,
        skipDeploy: options?.skipDeploy,
        onLaunchBrowser: (selection?: { agentName?: string; harnessName?: string }) => {
          pickerResult = selection ?? {};
          exitAltScreen();
          unmount();
        },
      })
    )
  );

  await waitUntilExit();
  exitAltScreen();
  return pickerResult;
}
