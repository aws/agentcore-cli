import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../../schema';
import type { ResourceStatusEntry, StatusContext } from '../../../commands/status/action';
import { handleProjectStatus, loadStatusConfig } from '../../../commands/status/action';
import { getErrorMessage } from '../../../errors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type StatusPhase = 'loading' | 'ready' | 'fetching-statuses' | 'error';

interface StatusState {
  phase: StatusPhase;
  error?: string;
  project?: AgentCoreProjectSpec;
  deployedState?: DeployedState;
  awsTargets?: AwsDeploymentTargets;
  targetIndex: number;
  resourceStatuses: ResourceStatusEntry[];
  statusesLoaded: boolean;
  statusesError?: string;
}

export function useStatusFlow() {
  const [state, setState] = useState<StatusState>({
    phase: 'loading',
    targetIndex: 0,
    resourceStatuses: [],
    statusesLoaded: false,
  });

  // Track the latest fetch so stale responses are ignored
  const fetchIdRef = useRef(0);

  // Initial load of project config and deployed state
  useEffect(() => {
    let active = true;
    loadStatusConfig()
      .then(context => {
        if (!active) return;

        setState(prev => ({
          ...prev,
          phase: 'ready',
          project: context.project,
          deployedState: context.deployedState,
          awsTargets: context.awsTargets,
        }));
      })
      .catch((error: Error) => {
        if (!active) return;
        setState(prev => ({ ...prev, phase: 'error', error: error.message }));
      });

    return () => {
      active = false;
    };
  }, []);

  const context = useMemo<StatusContext | null>(() => {
    if (!state.project || !state.deployedState || !state.awsTargets) return null;
    return {
      project: state.project,
      deployedState: state.deployedState,
      awsTargets: state.awsTargets,
    };
  }, [state.awsTargets, state.deployedState, state.project]);

  // Derive target names — fall back to awsTargets when deployedState is empty
  const targetNames = useMemo(() => {
    const deployedTargetNames = state.deployedState ? Object.keys(state.deployedState.targets) : [];
    if (deployedTargetNames.length > 0) return deployedTargetNames;
    return state.awsTargets?.map(t => t.name) ?? [];
  }, [state.deployedState, state.awsTargets]);

  const targetName = targetNames[state.targetIndex];

  const targetConfig = useMemo(() => {
    if (!state.awsTargets || !targetName) return undefined;
    return state.awsTargets.find(target => target.name === targetName);
  }, [state.awsTargets, targetName]);

  // Fetch project status with cancellation via fetch ID
  const fetchProjectStatus = useCallback(async () => {
    if (!context) return;

    const currentFetchId = ++fetchIdRef.current;

    setState(prev => ({
      ...prev,
      phase: 'fetching-statuses',
      statusesError: undefined,
    }));

    try {
      const result = await handleProjectStatus(context, { targetName });

      if (fetchIdRef.current !== currentFetchId) return;

      if (!result.success) {
        setState(prev => ({
          ...prev,
          phase: 'ready',
          statusesLoaded: true,
          statusesError: result.error?.message,
        }));
        return;
      }

      setState(prev => ({
        ...prev,
        phase: 'ready',
        resourceStatuses: result.resources,
        statusesLoaded: true,
        statusesError: undefined,
      }));
    } catch (error) {
      if (fetchIdRef.current !== currentFetchId) return;

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
      void fetchProjectStatus();
    }
  }, [state.phase, context, state.statusesLoaded, fetchProjectStatus]);

  const refreshStatuses = useCallback(() => {
    if (state.phase !== 'ready') return;
    setState(prev => ({ ...prev, statusesLoaded: false }));
  }, [state.phase]);

  const cycleTarget = useCallback(() => {
    if (!targetNames.length) return;
    setState(prev => ({
      ...prev,
      targetIndex: (prev.targetIndex + 1) % targetNames.length,
      resourceStatuses: [],
      statusesLoaded: false,
      statusesError: undefined,
    }));
  }, [targetNames.length]);

  return {
    phase: state.phase,
    error: state.error,
    project: state.project,
    projectName: state.project?.name ?? 'Unknown',
    targetName: targetName ?? 'No target configured',
    targetRegion: targetConfig?.region,
    hasMultipleTargets: targetNames.length > 1,
    resourceStatuses: state.resourceStatuses,
    statusesLoading: state.phase === 'fetching-statuses',
    statusesError: state.statusesError,
    cycleTarget,
    refreshStatuses,
  };
}
