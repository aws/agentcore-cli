import { ErrorPrompt, Panel, Screen, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useAgents, useBindMcpRuntime, useMcpRuntimeTools } from '../../hooks/useAttach';
import { useCreateMcpTool, useExistingGateways, useExistingToolNames } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddMcpToolScreen } from './AddMcpToolScreen';
import type { AddMcpToolConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'mode-select' }
  | { name: 'create-wizard' }
  | { name: 'bind-select-runtime' }
  | { name: 'bind-select-agent'; mcpRuntimeName: string }
  | { name: 'bind-enter-envvar'; mcpRuntimeName: string; targetAgent: string }
  | { name: 'create-success'; toolName: string; projectPath: string; loading?: boolean; loadingMessage?: string }
  | { name: 'bind-success'; mcpRuntimeName: string; targetAgent: string }
  | { name: 'error'; message: string };

interface AddMcpToolFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  /** Available agents */
  existingAgents: string[];
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create new MCP tool', description: 'Define a new MCP tool project' },
  { id: 'bind', title: 'Bind existing MCP runtime', description: 'Add an agent to an existing MCP runtime' },
];

export function AddMcpToolFlow({ isInteractive = true, existingAgents, onExit, onBack, onDeploy }: AddMcpToolFlowProps) {
  const { createTool, reset: resetCreate } = useCreateMcpTool();
  const { gateways: existingGateways } = useExistingGateways();
  const { toolNames: existingToolNames } = useExistingToolNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'mode-select' });

  // Bind flow hooks
  const { agents: allAgents, isLoading: isLoadingAgents } = useAgents();
  const { tools: mcpRuntimeTools } = useMcpRuntimeTools();
  const { bind: bindMcpRuntime } = useBindMcpRuntime();

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive) {
      if ((flow.name === 'create-success' && !flow.loading) || flow.name === 'bind-success') {
        onExit();
      }
    }
  }, [isInteractive, flow, onExit]);

  // Mode selection navigation
  const modeNav = useListNavigation({
    items: MODE_OPTIONS,
    onSelect: item => {
      if (item.id === 'create') {
        setFlow({ name: 'create-wizard' });
      } else {
        setFlow({ name: 'bind-select-runtime' });
      }
    },
    onExit: onBack,
    isActive: flow.name === 'mode-select',
  });

  // MCP Runtime selection for bind flow
  const runtimeItems: SelectableItem[] = useMemo(
    () => mcpRuntimeTools.map(name => ({ id: name, title: name })),
    [mcpRuntimeTools]
  );

  const runtimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => setFlow({ name: 'bind-select-agent', mcpRuntimeName: item.id }),
    onExit: () => setFlow({ name: 'mode-select' }),
    isActive: flow.name === 'bind-select-runtime',
  });

  // Agent selection for bind flow
  const agentItems: SelectableItem[] = useMemo(() => allAgents.map(name => ({ id: name, title: name })), [allAgents]);

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => {
      if (flow.name === 'bind-select-agent') {
        setFlow({ name: 'bind-enter-envvar', mcpRuntimeName: flow.mcpRuntimeName, targetAgent: item.id });
      }
    },
    onExit: () => setFlow({ name: 'bind-select-runtime' }),
    isActive: flow.name === 'bind-select-agent',
  });

  const handleCreateComplete = useCallback(
    (config: AddMcpToolConfig) => {
      setFlow({
        name: 'create-success',
        toolName: config.name,
        projectPath: '',
        loading: true,
        loadingMessage: 'Creating MCP tool...',
      });
      void createTool(config).then(result => {
        if (result.ok) {
          const { toolName, projectPath } = result.result;
          setFlow({ name: 'create-success', toolName, projectPath });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createTool]
  );

  const handleBindComplete = useCallback(
    async (envVarName: string) => {
      if (flow.name !== 'bind-enter-envvar') return;

      const result = await bindMcpRuntime(flow.mcpRuntimeName, {
        agentName: flow.targetAgent,
        envVarName,
      });

      if (result.ok) {
        setFlow({ name: 'bind-success', mcpRuntimeName: flow.mcpRuntimeName, targetAgent: flow.targetAgent });
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [flow, bindMcpRuntime]
  );

  // Mode selection screen
  if (flow.name === 'mode-select') {
    // Check if there are MCP runtimes to bind
    const hasRuntimesToBind = mcpRuntimeTools.length > 0;

    // If no MCP runtimes exist to bind, skip to create
    if (!hasRuntimesToBind) {
      return (
        <AddMcpToolScreen
          existingGateways={existingGateways}
          existingAgents={existingAgents}
          existingToolNames={existingToolNames}
          onComplete={handleCreateComplete}
          onExit={onBack}
        />
      );
    }

    return (
      <Screen title="Add MCP Tool" onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="What would you like to do?"
            description="Create a new MCP tool or bind an agent to an existing MCP runtime"
            items={MODE_OPTIONS}
            selectedIndex={modeNav.selectedIndex}
          />
        </Panel>
      </Screen>
    );
  }

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddMcpToolScreen
        existingGateways={existingGateways}
        existingAgents={existingAgents}
        existingToolNames={existingToolNames}
        onComplete={handleCreateComplete}
        onExit={() => setFlow({ name: 'mode-select' })}
      />
    );
  }

  // Bind flow - select MCP runtime
  if (flow.name === 'bind-select-runtime') {
    return (
      <Screen
        title="Bind MCP Runtime"
        onExit={() => setFlow({ name: 'mode-select' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select MCP runtime"
            description="Which MCP runtime should the agent be bound to?"
            items={runtimeItems}
            selectedIndex={runtimeNav.selectedIndex}
            emptyMessage="No MCP runtimes available. Create an MCP tool first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select agent
  if (flow.name === 'bind-select-agent') {
    if (isLoadingAgents) {
      return null;
    }
    return (
      <Screen
        title="Bind MCP Runtime"
        onExit={() => setFlow({ name: 'bind-select-runtime' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select agent to bind"
            description={`Which agent should have access to ${flow.mcpRuntimeName}?`}
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
            emptyMessage="No agents defined. Add an agent first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter env var name
  if (flow.name === 'bind-enter-envvar') {
    const defaultEnvVar = `${flow.mcpRuntimeName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_RUNTIME_URL`;
    return (
      <Screen
        title="Bind MCP Runtime"
        onExit={() => setFlow({ name: 'bind-select-agent', mcpRuntimeName: flow.mcpRuntimeName })}
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Environment variable name for MCP runtime URL"
            initialValue={defaultEnvVar}
            onSubmit={value => void handleBindComplete(value)}
            onCancel={() => setFlow({ name: 'bind-select-agent', mcpRuntimeName: flow.mcpRuntimeName })}
          />
        </Panel>
      </Screen>
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added MCP tool: ${flow.toolName}`}
        detail={`Project created at ${flow.projectPath}`}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={onBack}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Bind success
  if (flow.name === 'bind-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Bound agent to MCP runtime`}
        detail={`Agent "${flow.targetAgent}" is now bound to MCP runtime "${flow.mcpRuntimeName}".`}
        onAddAnother={onBack}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add MCP tool"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'mode-select' });
      }}
      onExit={onExit}
    />
  );
}
