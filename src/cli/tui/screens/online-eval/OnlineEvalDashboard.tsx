import type { GetOnlineEvalConfigResult } from '../../../aws/agentcore-control';
import { getOnlineEvaluationConfig } from '../../../aws/agentcore-control';
import { getErrorMessage } from '../../../errors';
import { handlePauseResume } from '../../../operations/eval';
import { loadDeployedProjectConfig } from '../../../operations/resolve-agent';
import { Panel, Screen } from '../../components';
import { useListNavigation } from '../../hooks';
import { STATUS_COLORS } from '../../theme';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface OnlineEvalDashboardProps {
  isInteractive: boolean;
  onExit: () => void;
}

interface DashboardConfig {
  name: string;
  configId: string;
  region: string;
  evaluators: string[];
  samplingRate: number;
  liveStatus?: string;
  executionStatus?: string;
  failureReason?: string;
  error?: string;
}

type Phase = 'loading' | 'loaded' | 'error' | 'toggling';

interface DashboardState {
  phase: Phase;
  configs: DashboardConfig[];
  error: string | null;
}

function executionStatusColor(status?: string): string {
  switch (status) {
    case 'ENABLED':
      return 'green';
    case 'DISABLED':
      return 'yellow';
    default:
      return 'gray';
  }
}

function configStatusColor(status?: string): string {
  switch (status?.toUpperCase()) {
    case 'ACTIVE':
      return 'green';
    case 'CREATING':
    case 'UPDATING':
      return 'yellow';
    case 'FAILED':
      return 'red';
    default:
      return 'gray';
  }
}

async function fetchDashboardConfigs(): Promise<DashboardConfig[]> {
  const context = await loadDeployedProjectConfig();
  const project = context.project;
  const targetNames = Object.keys(context.deployedState.targets);

  if (targetNames.length === 0) return [];

  const targetName = targetNames[0]!;
  const targetResources = context.deployedState.targets[targetName]?.resources;
  const targetConfig = context.awsTargets.find(t => t.name === targetName);
  const region = targetConfig?.region ?? 'us-east-1';
  const deployedOnlineEvals = targetResources?.onlineEvalConfigs ?? {};

  const localConfigs = project.onlineEvalConfigs ?? [];
  const configs: DashboardConfig[] = [];

  for (const local of localConfigs) {
    const deployed = deployedOnlineEvals[local.name];
    configs.push({
      name: local.name,
      configId: deployed?.onlineEvaluationConfigId ?? '',
      region,
      evaluators: local.evaluators,
      samplingRate: local.samplingRate,
      executionStatus: deployed?.executionStatus,
    });
  }

  // Enrich with live status from API
  await Promise.all(
    configs.map(async (config, i) => {
      if (!config.configId) return;
      try {
        const live: GetOnlineEvalConfigResult = await getOnlineEvaluationConfig({
          region: config.region,
          configId: config.configId,
        });
        configs[i] = {
          ...config,
          liveStatus: live.status,
          executionStatus: live.executionStatus,
          failureReason: live.failureReason,
        };
      } catch (err) {
        configs[i] = { ...config, error: getErrorMessage(err) };
      }
    })
  );

  return configs;
}

export function OnlineEvalDashboard({ onExit }: OnlineEvalDashboardProps) {
  const [state, setState] = useState<DashboardState>({
    phase: 'loading',
    configs: [],
    error: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    setState(prev => ({ ...prev, phase: 'loading', error: null }));
    setRefreshKey(k => k + 1);
  }, []);

  useInput(
    (input, key) => {
      if (input === 'r' && key.ctrl && state.phase === 'loaded') {
        refresh();
      }
    },
    { isActive: state.phase === 'loaded' }
  );

  useEffect(() => {
    mountedRef.current = true;
    fetchDashboardConfigs()
      .then(configs => {
        if (mountedRef.current) setState({ phase: 'loaded', configs, error: null });
      })
      .catch(err => {
        if (mountedRef.current) setState({ phase: 'error', configs: [], error: getErrorMessage(err) });
      });
    return () => {
      mountedRef.current = false;
    };
  }, [refreshKey]);

  const nav = useListNavigation({
    items: state.configs,
    onSelect: item => {
      if (!item.configId) return;
      const action = item.executionStatus === 'ENABLED' ? 'pause' : 'resume';
      setState(prev => ({ ...prev, phase: 'toggling' }));
      void handlePauseResume({ name: item.name }, action).then(result => {
        if (!result.success) {
          setState(prev => ({ ...prev, phase: 'loaded', error: result.error?.message ?? 'Toggle failed' }));
          return;
        }
        return fetchDashboardConfigs().then(configs => {
          if (mountedRef.current) setState({ phase: 'loaded', configs, error: null });
        });
      });
    },
    onExit: () => onExit(),
    isActive: state.phase === 'loaded' && state.configs.length > 0,
  });

  const helpText =
    state.configs.length > 0
      ? '↑↓ navigate · Enter toggle pause/resume · Ctrl+R refresh · Esc back'
      : 'Esc back · Ctrl+C quit';

  return (
    <Screen title="Online Eval Dashboard" onExit={onExit} helpText={helpText} exitEnabled={state.configs.length === 0}>
      {(state.phase === 'loading' || state.phase === 'toggling') && (
        <Text dimColor>{state.phase === 'toggling' ? 'Updating...' : 'Loading online eval configs...'}</Text>
      )}

      {state.phase === 'error' && <Text color={STATUS_COLORS.error}>{state.error}</Text>}

      {state.error && state.phase === 'loaded' && (
        <Box marginBottom={1}>
          <Text color={STATUS_COLORS.error}>{state.error}</Text>
        </Box>
      )}

      {state.phase === 'loaded' && state.configs.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>No online eval configs found in this project.</Text>
          <Text dimColor>Run `agentcore add online-eval` then `agentcore deploy` to get started.</Text>
          <Text dimColor>{'Tip: Use `agentcore pause online-eval --arn <ARN>` for configs outside the CLI.'}</Text>
        </Box>
      )}

      {state.phase === 'loaded' && state.configs.length > 0 && (
        <Panel fullWidth>
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Note: Evaluation results may take 5–10 minutes to appear after agent invocations.</Text>
            </Box>
            {state.configs.map((config, idx) => {
              const selected = idx === nav.selectedIndex;
              const isDeployed = Boolean(config.configId);
              const toggleLabel = config.executionStatus === 'ENABLED' ? 'Enter to pause' : 'Enter to resume';
              return (
                <Box key={config.name} flexDirection="column" marginBottom={idx < state.configs.length - 1 ? 1 : 0}>
                  <Text wrap="wrap">
                    <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                    <Text color={selected ? 'cyan' : undefined} bold={selected}>
                      {config.name}
                    </Text>
                    {config.liveStatus && (
                      <Text color={configStatusColor(config.liveStatus)}> [{config.liveStatus}]</Text>
                    )}
                    {config.executionStatus && (
                      <Text color={executionStatusColor(config.executionStatus)}> {config.executionStatus}</Text>
                    )}
                    {!isDeployed && <Text color="yellow"> [Not deployed]</Text>}
                  </Text>
                  <Text wrap="wrap">
                    <Text>{'  '}</Text>
                    <Text dimColor>
                      Evaluators: {config.evaluators.join(', ')}
                      {'  '}
                      Sampling: {config.samplingRate}%
                    </Text>
                  </Text>
                  {config.failureReason && (
                    <Text>
                      <Text>{'  '}</Text>
                      <Text color="red">Failure: {config.failureReason}</Text>
                    </Text>
                  )}
                  {config.error && (
                    <Text>
                      <Text>{'  '}</Text>
                      <Text color="red">Error: {config.error}</Text>
                    </Text>
                  )}
                  {selected && isDeployed && (
                    <Text>
                      <Text>{'  '}</Text>
                      <Text dimColor>{toggleLabel}</Text>
                    </Text>
                  )}
                  {selected && !isDeployed && (
                    <Text>
                      <Text>{'  '}</Text>
                      <Text dimColor>Run `agentcore deploy` to start this online eval config</Text>
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Panel>
      )}
    </Screen>
  );
}
