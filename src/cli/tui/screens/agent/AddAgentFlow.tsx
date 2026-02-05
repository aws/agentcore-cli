import { ErrorPrompt, Panel, Screen, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useAgents, useAttachAgent } from '../../hooks/useAttach';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddAgentScreen } from './AddAgentScreen';
import type { AddAgentConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'mode-select' }
  | { name: 'create-wizard' }
  | { name: 'bind-select-source' }
  | { name: 'bind-select-target'; sourceAgent: string }
  | { name: 'bind-enter-name'; sourceAgent: string; targetAgent: string }
  | { name: 'bind-enter-description'; sourceAgent: string; targetAgent: string; toolName: string }
  | { name: 'bind-enter-envvar'; sourceAgent: string; targetAgent: string; toolName: string; description: string }
  | { name: 'bind-success'; sourceAgent: string; targetAgent: string; toolName: string }
  | { name: 'error'; message: string };

interface AddAgentFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  /** Existing agent names */
  existingAgentNames: string[];
  /** Callback when an agent is created (create or byo) */
  onComplete: (config: AddAgentConfig) => void;
  onExit: () => void;
  onBack: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create or Add agent', description: 'Create new agent code or add existing code' },
  { id: 'bind', title: 'Bind as Remote Tool', description: 'Allow one agent to invoke another agent as a tool' },
];

export function AddAgentFlow({
  isInteractive = true,
  existingAgentNames,
  onComplete,
  onExit,
  onBack,
}: AddAgentFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'mode-select' });

  // Bind flow hooks
  const { agents: allAgents, isLoading: isLoadingAgents } = useAgents();
  const { attach: attachAgent } = useAttachAgent();

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'bind-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  // Mode selection navigation
  const modeNav = useListNavigation({
    items: MODE_OPTIONS,
    onSelect: item => {
      if (item.id === 'create') {
        setFlow({ name: 'create-wizard' });
      } else {
        setFlow({ name: 'bind-select-source' });
      }
    },
    onExit: onBack,
    isActive: flow.name === 'mode-select',
  });

  // Source agent selection for bind flow (the agent that will have the remote tool)
  const sourceAgentItems: SelectableItem[] = useMemo(
    () => allAgents.map(name => ({ id: name, title: name })),
    [allAgents]
  );

  const sourceAgentNav = useListNavigation({
    items: sourceAgentItems,
    onSelect: item => setFlow({ name: 'bind-select-target', sourceAgent: item.id }),
    onExit: () => setFlow({ name: 'mode-select' }),
    isActive: flow.name === 'bind-select-source',
  });

  // Target agent selection for bind flow (the agent to be invoked)
  const targetAgentItems: SelectableItem[] = useMemo(() => {
    if (flow.name !== 'bind-select-target') return [];
    return allAgents
      .filter(name => name !== flow.sourceAgent) // Can't invoke self
      .map(name => ({ id: name, title: name }));
  }, [allAgents, flow]);

  const targetAgentNav = useListNavigation({
    items: targetAgentItems,
    onSelect: item => {
      if (flow.name === 'bind-select-target') {
        setFlow({ name: 'bind-enter-name', sourceAgent: flow.sourceAgent, targetAgent: item.id });
      }
    },
    onExit: () => setFlow({ name: 'bind-select-source' }),
    isActive: flow.name === 'bind-select-target',
  });

  const handleBindComplete = useCallback(
    async (envVarName: string) => {
      if (flow.name !== 'bind-enter-envvar') return;

      const result = await attachAgent(flow.sourceAgent, {
        targetAgent: flow.targetAgent,
        name: flow.toolName,
        description: flow.description,
        envVarName,
      });

      if (result.ok) {
        setFlow({
          name: 'bind-success',
          sourceAgent: flow.sourceAgent,
          targetAgent: flow.targetAgent,
          toolName: flow.toolName,
        });
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [flow, attachAgent]
  );

  // Mode selection screen
  if (flow.name === 'mode-select') {
    // If there are fewer than 2 agents, can't bind agents together
    const canBind = allAgents.length >= 2;

    // If can't bind, skip to create wizard
    if (!canBind) {
      return <AddAgentScreen existingAgentNames={existingAgentNames} onComplete={onComplete} onExit={onBack} />;
    }

    return (
      <Screen title="Add Agent" onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="What would you like to do?"
            description="Create a new agent or bind an agent as a remote tool"
            items={MODE_OPTIONS}
            selectedIndex={modeNav.selectedIndex}
          />
        </Panel>
      </Screen>
    );
  }

  // Create wizard (delegates to existing AddAgentScreen)
  if (flow.name === 'create-wizard') {
    return (
      <AddAgentScreen
        existingAgentNames={existingAgentNames}
        onComplete={onComplete}
        onExit={() => setFlow({ name: 'mode-select' })}
      />
    );
  }

  // Bind flow - select source agent (the one that will have the remote tool)
  if (flow.name === 'bind-select-source') {
    if (isLoadingAgents) {
      return null;
    }
    return (
      <Screen
        title="Bind as Remote Tool"
        onExit={() => setFlow({ name: 'mode-select' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select source agent"
            description="Which agent should be able to invoke another agent?"
            items={sourceAgentItems}
            selectedIndex={sourceAgentNav.selectedIndex}
            emptyMessage="No agents defined. Add an agent first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select target agent (the agent to be invoked)
  if (flow.name === 'bind-select-target') {
    return (
      <Screen
        title="Bind as Remote Tool"
        onExit={() => setFlow({ name: 'bind-select-source' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select target agent"
            description={`Which agent should "${flow.sourceAgent}" be able to invoke?`}
            items={targetAgentItems}
            selectedIndex={targetAgentNav.selectedIndex}
            emptyMessage="No other agents available to invoke."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter tool name
  if (flow.name === 'bind-enter-name') {
    const defaultName = `invoke${flow.targetAgent.replace(/[^a-zA-Z0-9]/g, '')}`;
    return (
      <Screen
        title="Bind as Remote Tool"
        onExit={() => setFlow({ name: 'bind-select-target', sourceAgent: flow.sourceAgent })}
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Tool name (how this remote tool appears to the source agent)"
            initialValue={defaultName}
            onSubmit={value =>
              setFlow({
                name: 'bind-enter-description',
                sourceAgent: flow.sourceAgent,
                targetAgent: flow.targetAgent,
                toolName: value,
              })
            }
            onCancel={() => setFlow({ name: 'bind-select-target', sourceAgent: flow.sourceAgent })}
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter description
  if (flow.name === 'bind-enter-description') {
    const defaultDescription = `Invoke the ${flow.targetAgent} agent`;
    return (
      <Screen
        title="Bind as Remote Tool"
        onExit={() =>
          setFlow({ name: 'bind-enter-name', sourceAgent: flow.sourceAgent, targetAgent: flow.targetAgent })
        }
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Tool description"
            initialValue={defaultDescription}
            onSubmit={value =>
              setFlow({
                name: 'bind-enter-envvar',
                sourceAgent: flow.sourceAgent,
                targetAgent: flow.targetAgent,
                toolName: flow.toolName,
                description: value,
              })
            }
            onCancel={() =>
              setFlow({ name: 'bind-enter-name', sourceAgent: flow.sourceAgent, targetAgent: flow.targetAgent })
            }
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter env var name
  if (flow.name === 'bind-enter-envvar') {
    const defaultEnvVar = `${flow.toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_AGENT_ID`;
    return (
      <Screen
        title="Bind as Remote Tool"
        onExit={() =>
          setFlow({
            name: 'bind-enter-description',
            sourceAgent: flow.sourceAgent,
            targetAgent: flow.targetAgent,
            toolName: flow.toolName,
          })
        }
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Environment variable name for agent ID"
            initialValue={defaultEnvVar}
            onSubmit={value => void handleBindComplete(value)}
            onCancel={() =>
              setFlow({
                name: 'bind-enter-description',
                sourceAgent: flow.sourceAgent,
                targetAgent: flow.targetAgent,
                toolName: flow.toolName,
              })
            }
          />
        </Panel>
      </Screen>
    );
  }

  // Bind success
  if (flow.name === 'bind-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added remote tool: ${flow.toolName}`}
        detail={`Agent "${flow.sourceAgent}" can now invoke agent "${flow.targetAgent}" as a remote tool.`}
        onAddAnother={onBack}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to bind agent"
      detail={flow.message}
      onBack={() => {
        setFlow({ name: 'mode-select' });
      }}
      onExit={onExit}
    />
  );
}
