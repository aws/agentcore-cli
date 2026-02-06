import type { AwsDeploymentTarget } from '../../../../schema';
import { ErrorPrompt } from '../../components';
import { useAvailableAgents } from '../../hooks/useCreateMcp';
import { AddAgentFlow } from '../agent/AddAgentFlow';
import type { AddAgentConfig } from '../agent/types';
import { FRAMEWORK_OPTIONS } from '../agent/types';
import { useAddAgent } from '../agent/useAddAgent';
import { AddIdentityFlow } from '../identity';
import { AddGatewayFlow, AddMcpToolFlow } from '../mcp';
import { AddMemoryFlow } from '../memory/AddMemoryFlow';
import type { AddResourceType } from './AddScreen';
import { AddScreen } from './AddScreen';
import { AddSuccessScreen } from './AddSuccessScreen';
import { AddTargetScreen } from './AddTargetScreen';
import { useAddTarget, useExistingTargets } from './useAddTarget';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'select' }
  | { name: 'agent-wizard' }
  | { name: 'gateway-wizard' }
  | { name: 'tool-wizard' }
  | { name: 'memory-wizard' }
  | { name: 'identity-wizard' }
  | { name: 'target-wizard' }
  | {
      name: 'agent-create-success';
      agentName: string;
      projectPath: string;
      config: AddAgentConfig;
      loading?: boolean;
      loadingMessage?: string;
    }
  | { name: 'agent-byo-success'; agentName: string; config: AddAgentConfig; loading?: boolean; loadingMessage?: string }
  | { name: 'target-success'; targetName: string; loading?: boolean; loadingMessage?: string }
  | { name: 'error'; message: string };

/** Tree-style display of added agent details */
function AgentAddedSummary({ config, projectPath }: { config: AddAgentConfig; projectPath?: string }) {
  const getFrameworkLabel = (framework: string) => {
    const option = FRAMEWORK_OPTIONS.find(o => o.id === framework);
    return option?.title ?? framework;
  };

  const isCreate = config.agentType === 'create';

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Added:</Text>
      <Box flexDirection="column" marginLeft={2}>
        {isCreate && projectPath && (
          <Text>
            app/{config.name}/
            <Text dimColor>
              {'  '}
              {config.language} agent ({getFrameworkLabel(config.framework)})
            </Text>
          </Text>
        )}
        {!isCreate && (
          <Text>
            {config.codeLocation}
            <Text dimColor>
              {'  '}
              {config.language} agent ({getFrameworkLabel(config.framework)})
            </Text>
          </Text>
        )}
        <Text>
          agentcore/agentcore.json
          <Text dimColor>{'  '}Agent config added</Text>
        </Text>
        {config.memory !== 'none' && (
          <Text>
            agentcore/agentcore.json
            <Text dimColor>
              {'  '}Memory: {config.memory}
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

interface AddFlowProps {
  /** Whether running in interactive TUI mode (from App.tsx) vs CLI mode */
  isInteractive: boolean;
  onExit: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddFlow(props: AddFlowProps) {
  const { addAgent, reset: resetAgent } = useAddAgent();
  const { addTarget, reset: resetTarget } = useAddTarget();
  const { agents, isLoading: isLoadingAgents, refresh: refreshAgents } = useAvailableAgents();
  const { targets, refresh: refreshTargets } = useExistingTargets();
  const [flow, setFlow] = useState<FlowState>({ name: 'select' });

  // Load existing targets on mount
  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!props.isInteractive) {
      const successStates = ['agent-create-success', 'agent-byo-success', 'target-success'];
      if (successStates.includes(flow.name) && !('loading' in flow && flow.loading)) {
        props.onExit();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.isInteractive, flow, props.onExit]);

  const handleSelectResource = useCallback((resourceType: AddResourceType) => {
    switch (resourceType) {
      case 'agent':
        setFlow({ name: 'agent-wizard' });
        break;
      case 'gateway':
        setFlow({ name: 'gateway-wizard' });
        break;
      case 'mcp-tool':
        setFlow({ name: 'tool-wizard' });
        break;
      case 'memory':
        setFlow({ name: 'memory-wizard' });
        break;
      case 'identity':
        setFlow({ name: 'identity-wizard' });
        break;
      case 'target':
        setFlow({ name: 'target-wizard' });
        break;
    }
  }, []);

  const handleAddAgent = useCallback(
    (config: AddAgentConfig) => {
      // Show loading state in success screen
      setFlow({
        name: 'agent-create-success',
        agentName: config.name,
        projectPath: '',
        config,
        loading: true,
        loadingMessage: 'Creating agent...',
      });
      void addAgent(config).then(result => {
        if (result.ok) {
          if (result.type === 'create') {
            setFlow({
              name: 'agent-create-success',
              agentName: result.agentName,
              projectPath: result.projectPath,
              config,
            });
          } else {
            setFlow({ name: 'agent-byo-success', agentName: result.agentName, config });
          }
        } else {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [addAgent]
  );

  const handleAddTarget = useCallback(
    (target: AwsDeploymentTarget) => {
      setFlow({
        name: 'target-success',
        targetName: target.name,
        loading: true,
        loadingMessage: 'Adding target...',
      });
      void addTarget(target).then(result => {
        if (result.ok) {
          setFlow({ name: 'target-success', targetName: result.targetName });
        } else {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [addTarget]
  );

  if (flow.name === 'select') {
    // Show screen immediately - loading is instant for local files
    return (
      <AddScreen
        onSelect={handleSelectResource}
        onExit={props.onExit}
        hasAgents={!isLoadingAgents && agents.length > 0}
      />
    );
  }

  // Agent wizard - now uses AddAgentFlow with mode selection
  if (flow.name === 'agent-wizard') {
    return (
      <AddAgentFlow
        isInteractive={props.isInteractive}
        existingAgentNames={agents}
        onComplete={handleAddAgent}
        onExit={props.onExit}
        onBack={() => setFlow({ name: 'select' })}
        onDeploy={props.onDeploy}
      />
    );
  }

  if (flow.name === 'agent-create-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Created agent: ${flow.agentName}`}
        summary={!flow.loading && <AgentAddedSummary config={flow.config} projectPath={flow.projectPath} />}
        detail="Deploy with `agentcore deploy`."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refreshAgents().then(() => setFlow({ name: 'select' }));
        }}
        onDeploy={props.onDeploy}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'agent-byo-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added agent: ${flow.agentName}`}
        summary={!flow.loading && <AgentAddedSummary config={flow.config} />}
        detail="Deploy with `agentcore deploy`."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refreshAgents().then(() => setFlow({ name: 'select' }));
        }}
        onDeploy={props.onDeploy}
        onExit={props.onExit}
      />
    );
  }

  // Gateway wizard - now uses AddGatewayFlow with mode selection
  if (flow.name === 'gateway-wizard') {
    return (
      <AddGatewayFlow
        isInteractive={props.isInteractive}
        availableAgents={agents}
        onExit={props.onExit}
        onBack={() => setFlow({ name: 'select' })}
        onDeploy={props.onDeploy}
      />
    );
  }

  // MCP Tool wizard - now uses AddMcpToolFlow with mode selection
  if (flow.name === 'tool-wizard') {
    return (
      <AddMcpToolFlow
        isInteractive={props.isInteractive}
        existingAgents={agents}
        onExit={props.onExit}
        onBack={() => setFlow({ name: 'select' })}
        onDeploy={props.onDeploy}
      />
    );
  }

  // Memory wizard - already uses AddMemoryFlow with mode selection
  if (flow.name === 'memory-wizard') {
    return (
      <AddMemoryFlow
        isInteractive={props.isInteractive}
        onBack={() => setFlow({ name: 'select' })}
        onExit={props.onExit}
        onDeploy={props.onDeploy}
      />
    );
  }

  // Identity wizard - now uses AddIdentityFlow with mode selection
  if (flow.name === 'identity-wizard') {
    // Wait for agents to load before rendering wizard
    if (agents.length === 0) {
      return null;
    }
    return (
      <AddIdentityFlow
        isInteractive={props.isInteractive}
        onExit={props.onExit}
        onBack={() => setFlow({ name: 'select' })}
        onDeploy={props.onDeploy}
      />
    );
  }

  if (flow.name === 'target-wizard') {
    return (
      <AddTargetScreen
        existingTargetNames={targets}
        onComplete={handleAddTarget}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'target-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added target: ${flow.targetName}`}
        detail="Target defined in `agentcore/aws-targets.json`."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refreshTargets().then(() => setFlow({ name: 'select' }));
        }}
        onDeploy={props.onDeploy}
        onExit={props.onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add resource"
      detail={flow.message}
      onBack={() => {
        resetAgent();
        resetTarget();
        setFlow({ name: 'select' });
      }}
      onExit={props.onExit}
    />
  );
}
