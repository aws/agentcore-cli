import { ConfigIO } from '../../../../lib';
import type {
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  AwsDeploymentTargets,
  DeployedResourceState,
  DeployedState,
} from '../../../../schema';
import type { StatusContext, StatusEntry } from '../../../commands/status/action';
import { handleStatusAll, loadStatusConfig } from '../../../commands/status/action';
import { getErrorMessage } from '../../../errors';
import { useCallback, useEffect, useMemo, useState } from 'react';

type StatusPhase = 'loading' | 'ready' | 'fetching-statuses' | 'error';

interface AgentEntry {
  name: string;
  isDeployed: boolean;
  runtimeId?: string;
}

interface StatusState {
  phase: StatusPhase;
  error?: string;
  project?: AgentCoreProjectSpec;
  deployedState?: DeployedState;
  awsTargets?: AwsDeploymentTargets;
  mcpSpec?: AgentCoreMcpSpec;
  targetIndex: number;
  allStatuses: Record<string, StatusEntry>;
  statusesLoaded: boolean;
  statusesError?: string;
}

export function useStatusFlow() {
  const [state, setState] = useState<StatusState>({
    phase: 'loading',
    targetIndex: 0,
    allStatuses: {},
    statusesLoaded: false,
  });

  const configIO = useMemo(() => new ConfigIO(), []);

  // Initial load of project config, deployed state, and MCP spec
  useEffect(() => {
    let active = true;
    loadStatusConfig()
      .then(async context => {
        if (!active) return;

        // Validate before setting ready
        if (!context.project.agents.length) {
          setState(prev => ({ ...prev, phase: 'error', error: 'No agents defined in configuration.' }));
          return;
        }

        const deployedTargets = Object.keys(context.deployedState.targets);
        if (deployedTargets.length === 0) {
          setState(prev => ({
            ...prev,
            phase: 'error',
            error: 'No deployed targets found. Run `agentcore deploy` first.',
          }));
          return;
        }

        // Load MCP spec if it exists
        let mcpSpec: AgentCoreMcpSpec | undefined;
        if (configIO.configExists('mcp')) {
          try {
            mcpSpec = await configIO.readMcpSpec();
          } catch {
            // Ignore MCP load errors
          }
        }

        setState(prev => ({
          ...prev,
          phase: 'ready',
          project: context.project,
          deployedState: context.deployedState,
          awsTargets: context.awsTargets,
          mcpSpec,
        }));
      })
      .catch((error: Error) => {
        if (!active) return;
        setState(prev => ({ ...prev, phase: 'error', error: error.message }));
      });

    return () => {
      active = false;
    };
  }, [configIO]);

  const context = useMemo<StatusContext | null>(() => {
    if (!state.project || !state.deployedState || !state.awsTargets) return null;
    return {
      project: state.project,
      deployedState: state.deployedState,
      awsTargets: state.awsTargets,
    };
  }, [state.awsTargets, state.deployedState, state.project]);

  const targetNames = useMemo(() => {
    if (!state.deployedState) return [];
    return Object.keys(state.deployedState.targets);
  }, [state.deployedState]);

  const targetName = targetNames[state.targetIndex];

  const targetConfig = useMemo(() => {
    if (!state.awsTargets || !targetName) return undefined;
    return state.awsTargets.find(target => target.name === targetName);
  }, [state.awsTargets, targetName]);

  const agents = useMemo<AgentEntry[]>(() => {
    if (!state.project) return [];
    const deployedAgents = state.deployedState?.targets?.[targetName ?? '']?.resources?.agents;
    return state.project.agents.map(agent => {
      const agentState = deployedAgents?.[agent.name];
      return {
        name: agent.name,
        isDeployed: !!agentState,
        runtimeId: agentState?.runtimeId,
      };
    });
  }, [state.deployedState, state.project, targetName]);

  // Get deployed resources for current target
  const deployedResources = useMemo<DeployedResourceState | undefined>(() => {
    if (!state.deployedState || !targetName) return undefined;
    return state.deployedState.targets[targetName]?.resources;
  }, [state.deployedState, targetName]);

  // Fetch all statuses when ready and target changes
  const fetchAllStatuses = useCallback(async () => {
    if (!context || !targetName) return;

    setState(prev => ({
      ...prev,
      phase: 'fetching-statuses',
      statusesError: undefined,
    }));

    try {
      const result = await handleStatusAll(context, { targetName });

      if (!result.success) {
        setState(prev => ({
          ...prev,
          phase: 'ready',
          statusesLoaded: true,
          statusesError: result.error,
        }));
        return;
      }

      // Convert entries array to record keyed by agent name
      const statusMap: Record<string, StatusEntry> = {};
      for (const entry of result.entries ?? []) {
        statusMap[entry.agentName] = entry;
      }

      setState(prev => ({
        ...prev,
        phase: 'ready',
        allStatuses: statusMap,
        statusesLoaded: true,
        statusesError: undefined,
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        phase: 'ready',
        statusesLoaded: true,
        statusesError: getErrorMessage(error),
      }));
    }
  }, [context, targetName]);

  // Fetch statuses when ready and target changes
  useEffect(() => {
    if (state.phase === 'ready' && context && !state.statusesLoaded) {
      void fetchAllStatuses();
    }
  }, [state.phase, context, state.statusesLoaded, fetchAllStatuses]);

  // Refresh statuses function
  const refreshStatuses = useCallback(() => {
    if (state.phase !== 'ready' && state.phase !== 'fetching-statuses') return;
    setState(prev => ({ ...prev, statusesLoaded: false }));
  }, [state.phase]);

  const cycleTarget = useCallback(() => {
    if (!targetNames.length) return;
    setState(prev => ({
      ...prev,
      targetIndex: (prev.targetIndex + 1) % targetNames.length,
      allStatuses: {},
      statusesLoaded: false,
      statusesError: undefined,
    }));
  }, [targetNames.length]);

  return {
    phase: state.phase,
    error: state.error,
    project: state.project,
    projectName: state.project?.name ?? 'Unknown',
    targetName: targetName ?? 'Unknown',
    targetRegion: targetConfig?.region,
    agents,
    hasMultipleTargets: targetNames.length > 1,
    mcpSpec: state.mcpSpec,
    allStatuses: state.allStatuses,
    statusesLoading: state.phase === 'fetching-statuses',
    statusesError: state.statusesError,
    deployedResources,
    cycleTarget,
    refreshStatuses,
  };
}
