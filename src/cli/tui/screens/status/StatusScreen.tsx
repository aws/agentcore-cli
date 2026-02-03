import { type AgentStatusInfo, ResourceGraph, Screen } from '../../components';
import { useStatusFlow } from './useStatusFlow';
import { Box, Text, useInput } from 'ink';
import React, { useMemo } from 'react';

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
    mcpSpec,
    allStatuses,
    statusesLoading,
    statusesError,
    deployedResources,
    cycleTarget,
    refreshStatuses,
  } = useStatusFlow();

  // Convert allStatuses to AgentStatusInfo format for ResourceGraph
  const graphStatuses = useMemo<Record<string, AgentStatusInfo>>(() => {
    const result: Record<string, AgentStatusInfo> = {};
    for (const [agentName, entry] of Object.entries(allStatuses)) {
      result[agentName] = {
        runtimeStatus: entry.isDeployed ? entry.runtimeStatus : 'not deployed',
        error: entry.error,
      };
    }
    return result;
  }, [allStatuses]);

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
        <Box marginTop={1}>
          <ResourceGraph
            project={project}
            mcp={mcpSpec}
            agentStatuses={graphStatuses}
            deployedAgents={deployedResources?.agents}
          />
        </Box>
      )}

      {/* Deployed MCP Resources - only show if there are MCP resources */}
      {deployedResources?.mcp &&
        (Object.keys(deployedResources.mcp.gateways ?? {}).length > 0 ||
          Object.keys(deployedResources.mcp.runtimes ?? {}).length > 0 ||
          Object.keys(deployedResources.mcp.lambdas ?? {}).length > 0) && (
          <Box marginTop={1} flexDirection="column">
            <Text bold dimColor>
              ─ Deployed MCP Resources ─
            </Text>

            {/* MCP Gateways */}
            {deployedResources.mcp.gateways && Object.keys(deployedResources.mcp.gateways).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {Object.entries(deployedResources.mcp.gateways).map(([name, state]) => (
                  <Box key={name} marginLeft={2}>
                    <Text>
                      <Text color="yellow">◆ {name}</Text>
                      <Text dimColor> {state.gatewayId}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            )}

            {/* MCP Runtimes */}
            {deployedResources.mcp.runtimes && Object.keys(deployedResources.mcp.runtimes).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {Object.entries(deployedResources.mcp.runtimes).map(([name, state]) => (
                  <Box key={name} marginLeft={2}>
                    <Text>
                      <Text color="magenta">▶ {name}</Text>
                      <Text dimColor> {state.runtimeId}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            )}

            {/* MCP Lambdas */}
            {deployedResources.mcp.lambdas && Object.keys(deployedResources.mcp.lambdas).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {Object.entries(deployedResources.mcp.lambdas).map(([name, state]) => (
                  <Box key={name} marginLeft={2}>
                    <Text>
                      <Text color="magenta">λ {name}</Text>
                      <Text dimColor> {state.functionName}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
    </Screen>
  );
}
