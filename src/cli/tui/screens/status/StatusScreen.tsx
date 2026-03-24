import { ResourceGraph, Screen } from '../../components';
import { useStatusFlow } from './useStatusFlow';
import { Box, Text, useInput } from 'ink';
import React from 'react';

interface StatusScreenProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
}

export function StatusScreen({ isInteractive: _isInteractive, onExit }: StatusScreenProps) {
  const {
    phase,
    error,
    project,
    projectName,
    targetName,
    targetRegion,
    hasMultipleTargets,
    resourceStatuses,
    statusesLoading,
    statusesError,
    cycleTarget,
    refreshStatuses,
  } = useStatusFlow();

  useInput(
    (input, key) => {
      if (phase !== 'ready' && phase !== 'fetching-statuses') return;
      if (input === 't' && hasMultipleTargets) {
        cycleTarget();
      }
      if (input === 'r' && key.ctrl) {
        refreshStatuses();
      }
    },
    { isActive: phase === 'ready' || phase === 'fetching-statuses' }
  );

  if (phase === 'loading') {
    return (
      <Screen title="AgentCore Status" onExit={onExit}>
        <Text dimColor>Loading project status...</Text>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen title="AgentCore Status" onExit={onExit}>
        <Text color="red">{error}</Text>
      </Screen>
    );
  }

  const helpParts = ['Ctrl+R refresh runtime status'];
  if (hasMultipleTargets) {
    helpParts.push('T target');
  }
  helpParts.push('Esc back', 'Ctrl+C quit');
  const helpText = helpParts.join(' · ');

  const headerContent = (
    <Box flexDirection="column">
      <Box>
        <Text>Project: </Text>
        <Text color="green">{projectName}</Text>
      </Box>
      <Box>
        <Text>Target: </Text>
        <Text color="yellow">
          {targetName}
          {targetRegion ? ` (${targetRegion})` : ''}
        </Text>
      </Box>
    </Box>
  );

  return (
    <Screen title="AgentCore Status" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      {statusesLoading && (
        <Box marginTop={1}>
          <Text dimColor>Fetching runtime statuses...</Text>
        </Box>
      )}

      {statusesError && (
        <Box marginTop={1}>
          <Text color="red">Error fetching statuses: {statusesError}</Text>
        </Box>
      )}

      {project && (
        <ResourceGraph
          project={project}
          mcp={
            project.agentCoreGateways?.length
              ? {
                  agentCoreGateways: project.agentCoreGateways,
                  mcpRuntimeTools: project.mcpRuntimeTools,
                  unassignedTargets: project.unassignedTargets,
                }
              : undefined
          }
          resourceStatuses={resourceStatuses}
        />
      )}
    </Screen>
  );
}
