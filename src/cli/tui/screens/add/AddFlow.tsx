import type { AwsDeploymentTarget } from '../../../../schema';
import { ErrorPrompt } from '../../components';
import {
  useAvailableAgents,
  useCreateGateway,
  useCreateMcpTool,
  useExistingGateways,
  useExistingToolNames,
} from '../../hooks/useCreateMcp';
import { AddAgentScreen } from '../agent/AddAgentScreen';
import type { AddAgentConfig } from '../agent/types';
import { FRAMEWORK_OPTIONS } from '../agent/types';
import { useAddAgent } from '../agent/useAddAgent';
import { AddIdentityScreen, useCreateIdentity, useExistingIdentityNames } from '../identity';
import type { AddIdentityConfig } from '../identity';
import { AddGatewayScreen } from '../mcp/AddGatewayScreen';
import { AddMcpToolScreen } from '../mcp/AddMcpToolScreen';
import type { AddGatewayConfig, AddMcpToolConfig } from '../mcp/types';
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
  | { name: 'gateway-success'; gatewayName: string; loading?: boolean; loadingMessage?: string }
  | { name: 'tool-success'; toolName: string; projectPath: string; loading?: boolean; loadingMessage?: string }
  | { name: 'identity-success'; identityName: string; loading?: boolean; loadingMessage?: string }
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
  /** Navigate to another command (e.g., 'attach') */
  onNavigate?: (command: string) => void;
}

export function AddFlow(props: AddFlowProps) {
  const { addAgent, reset: resetAgent } = useAddAgent();
  const { createGateway, reset: resetGateway } = useCreateGateway();
  const { createTool, reset: resetTool } = useCreateMcpTool();
  const { createIdentity, reset: resetIdentity } = useCreateIdentity();
  const { addTarget, reset: resetTarget } = useAddTarget();
  const { gateways, refresh } = useExistingGateways();
  const { agents, isLoading: isLoadingAgents, refresh: refreshAgents } = useAvailableAgents();
  const { toolNames } = useExistingToolNames();
  const { identityNames, refresh: refreshIdentityNames } = useExistingIdentityNames();
  const { targets, refresh: refreshTargets } = useExistingTargets();
  const [flow, setFlow] = useState<FlowState>({ name: 'select' });

  // Load existing targets on mount
  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!props.isInteractive) {
      const successStates = [
        'agent-create-success',
        'agent-byo-success',
        'gateway-success',
        'tool-success',
        'identity-success',
        'target-success',
      ];
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

  const handleCreateGateway = useCallback(
    (config: AddGatewayConfig) => {
      setFlow({
        name: 'gateway-success',
        gatewayName: config.name,
        loading: true,
        loadingMessage: 'Creating gateway...',
      });
      void createGateway(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'gateway-success', gatewayName: result.result.name });
        } else {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [createGateway]
  );

  const handleCreateTool = useCallback(
    (config: AddMcpToolConfig) => {
      setFlow({
        name: 'tool-success',
        toolName: config.name,
        projectPath: '',
        loading: true,
        loadingMessage: 'Creating MCP tool...',
      });
      void createTool(config).then(res => {
        if (res.ok) {
          const { toolName, projectPath } = res.result;
          setFlow({ name: 'tool-success', toolName, projectPath });
        } else {
          setFlow({ name: 'error', message: res.error });
        }
      });
    },
    [createTool]
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

  const handleCreateIdentity = useCallback(
    (config: AddIdentityConfig) => {
      setFlow({
        name: 'identity-success',
        identityName: config.name,
        loading: true,
        loadingMessage: 'Creating identity...',
      });
      void createIdentity(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'identity-success', identityName: result.result.name });
        } else {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [createIdentity]
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

  if (flow.name === 'agent-wizard') {
    return (
      <AddAgentScreen
        existingAgentNames={agents}
        onComplete={handleAddAgent}
        onExit={() => setFlow({ name: 'select' })}
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
        onAttach={() => props.onNavigate?.('attach')}
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
        onAttach={() => props.onNavigate?.('attach')}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'gateway-wizard') {
    return (
      <AddGatewayScreen
        existingGateways={gateways}
        availableAgents={agents}
        onComplete={handleCreateGateway}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'tool-wizard') {
    return (
      <AddMcpToolScreen
        existingGateways={gateways}
        existingAgents={agents}
        existingToolNames={toolNames}
        onComplete={handleCreateTool}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  if (flow.name === 'memory-wizard') {
    return (
      <AddMemoryFlow
        isInteractive={props.isInteractive}
        onBack={() => setFlow({ name: 'select' })}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'identity-wizard') {
    // Wait for agents to load before rendering wizard
    if (agents.length === 0) {
      return null;
    }
    return (
      <AddIdentityScreen
        existingIdentityNames={identityNames}
        availableAgents={agents}
        onComplete={handleCreateIdentity}
        onExit={() => setFlow({ name: 'select' })}
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

  if (flow.name === 'gateway-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added gateway: ${flow.gatewayName}`}
        detail="Gateway defined in `agentcore/mcp.json`. Next: Use 'add tool' with 'Behind Gateway' exposure to route tools through this gateway."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refresh().then(() => setFlow({ name: 'select' }));
        }}
        onAttach={() => props.onNavigate?.('attach')}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'tool-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added MCP tool: ${flow.toolName}`}
        detail={`Project created at ${flow.projectPath}`}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => setFlow({ name: 'select' })}
        onAttach={() => props.onNavigate?.('attach')}
        onExit={props.onExit}
      />
    );
  }

  if (flow.name === 'identity-success') {
    return (
      <AddSuccessScreen
        isInteractive={props.isInteractive}
        message={`Added identity: ${flow.identityName}`}
        detail="`agentcore/.env` updated."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refreshIdentityNames().then(() => setFlow({ name: 'select' }));
        }}
        onAttach={() => props.onNavigate?.('attach')}
        onExit={props.onExit}
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
        onAttach={() => props.onNavigate?.('attach')}
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
        resetGateway();
        resetTool();
        resetIdentity();
        resetTarget();
        setFlow({ name: 'select' });
      }}
      onExit={props.onExit}
    />
  );
}
