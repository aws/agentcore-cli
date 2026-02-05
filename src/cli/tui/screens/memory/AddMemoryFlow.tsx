import type { Access } from '../../../../schema';
import { ErrorPrompt, Panel, Screen, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useAgents, useAttachMemory, useOwnedMemories } from '../../hooks/useAttach';
import { useAvailableAgentsForMemory, useCreateMemory, useExistingMemoryNames } from '../../hooks/useCreateMemory';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddMemoryScreen } from './AddMemoryScreen';
import type { AddMemoryConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'mode-select' }
  | { name: 'create-wizard' }
  | { name: 'bind-select-agent' }
  | { name: 'bind-select-memory'; targetAgent: string }
  | { name: 'bind-select-access'; targetAgent: string; memoryName: string }
  | { name: 'bind-enter-envvar'; targetAgent: string; memoryName: string; access: Access }
  | { name: 'create-success'; memoryName: string; ownerAgent: string }
  | { name: 'bind-success'; memoryName: string; targetAgent: string }
  | { name: 'error'; message: string };

interface AddMemoryFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create new memory', description: 'Define a new memory provider for an agent' },
  { id: 'bind', title: 'Bind existing memory', description: 'Grant another agent access to an existing memory' },
];

const ACCESS_OPTIONS: SelectableItem[] = [
  { id: 'read', title: 'Read-only', description: 'Agent can only read from memory' },
  { id: 'readwrite', title: 'Read/Write', description: 'Agent can read and write to memory' },
];

export function AddMemoryFlow({ isInteractive = true, onExit, onBack }: AddMemoryFlowProps) {
  const { createMemory, reset: resetCreate } = useCreateMemory();
  const { names: existingNames } = useExistingMemoryNames();
  const { agents: createAgents } = useAvailableAgentsForMemory();
  const [flow, setFlow] = useState<FlowState>({ name: 'mode-select' });

  // Bind flow hooks
  const { agents: allAgents, isLoading: isLoadingAgents } = useAgents();
  const { memories: ownedMemories } = useOwnedMemories();
  const { attach: attachMemory } = useAttachMemory();

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && (flow.name === 'create-success' || flow.name === 'bind-success')) {
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
        setFlow({ name: 'bind-select-agent' });
      }
    },
    onExit: onBack,
    isActive: flow.name === 'mode-select',
  });

  // Agent selection for bind flow
  const agentItems: SelectableItem[] = useMemo(() => allAgents.map(name => ({ id: name, title: name })), [allAgents]);

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => setFlow({ name: 'bind-select-memory', targetAgent: item.id }),
    onExit: () => setFlow({ name: 'mode-select' }),
    isActive: flow.name === 'bind-select-agent',
  });

  // Memory selection for bind flow - filter out memories already attached to target agent
  const memoryItems: SelectableItem[] = useMemo(() => {
    if (flow.name !== 'bind-select-memory') return [];
    return ownedMemories
      .filter(m => m.ownerAgent !== flow.targetAgent) // Can't bind memory to its owner
      .map(m => ({
        id: m.name,
        title: m.name,
        description: `Owned by ${m.ownerAgent}`,
      }));
  }, [ownedMemories, flow]);

  const memoryNav = useListNavigation({
    items: memoryItems,
    onSelect: item => {
      if (flow.name === 'bind-select-memory') {
        setFlow({ name: 'bind-select-access', targetAgent: flow.targetAgent, memoryName: item.id });
      }
    },
    onExit: () => setFlow({ name: 'bind-select-agent' }),
    isActive: flow.name === 'bind-select-memory',
  });

  // Access level selection
  const accessNav = useListNavigation({
    items: ACCESS_OPTIONS,
    onSelect: item => {
      if (flow.name === 'bind-select-access') {
        setFlow({
          name: 'bind-enter-envvar',
          targetAgent: flow.targetAgent,
          memoryName: flow.memoryName,
          access: item.id as Access,
        });
      }
    },
    onExit: () => {
      if (flow.name === 'bind-select-access') {
        setFlow({ name: 'bind-select-memory', targetAgent: flow.targetAgent });
      }
    },
    isActive: flow.name === 'bind-select-access',
  });

  const handleCreateComplete = useCallback(
    (config: AddMemoryConfig) => {
      void createMemory(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', memoryName: result.result.name, ownerAgent: result.result.ownerAgent });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createMemory]
  );

  const handleBindComplete = useCallback(
    async (envVarName: string) => {
      if (flow.name !== 'bind-enter-envvar') return;

      const result = await attachMemory(flow.targetAgent, {
        memoryName: flow.memoryName,
        access: flow.access,
        envVarName,
      });

      if (result.ok) {
        setFlow({ name: 'bind-success', memoryName: flow.memoryName, targetAgent: flow.targetAgent });
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [flow, attachMemory]
  );

  // Mode selection screen
  if (flow.name === 'mode-select') {
    // Check if there are owned memories to bind
    const hasMemoriesToBind = ownedMemories.length > 0;

    // If no memories exist to bind, show only create option or skip to create
    if (!hasMemoriesToBind) {
      return (
        <AddMemoryScreen
          existingMemoryNames={existingNames}
          availableAgents={createAgents}
          onComplete={handleCreateComplete}
          onExit={onBack}
        />
      );
    }

    return (
      <Screen title="Add Memory" onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="What would you like to do?"
            description="Create a new memory or bind an existing one to another agent"
            items={MODE_OPTIONS}
            selectedIndex={modeNav.selectedIndex}
          />
        </Panel>
      </Screen>
    );
  }

  // Create wizard
  if (flow.name === 'create-wizard') {
    if (createAgents.length === 0) {
      return (
        <ErrorPrompt
          message="No agents available. Add an agent first before creating a memory."
          onBack={() => setFlow({ name: 'mode-select' })}
        />
      );
    }
    return (
      <AddMemoryScreen
        existingMemoryNames={existingNames}
        availableAgents={createAgents}
        onComplete={handleCreateComplete}
        onExit={() => setFlow({ name: 'mode-select' })}
      />
    );
  }

  // Bind flow - select agent
  if (flow.name === 'bind-select-agent') {
    if (isLoadingAgents) {
      return null;
    }
    return (
      <Screen title="Bind Memory" onExit={() => setFlow({ name: 'mode-select' })} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="Select target agent"
            description="Which agent should have access to the memory?"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
            emptyMessage="No agents defined. Add an agent first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select memory
  if (flow.name === 'bind-select-memory') {
    return (
      <Screen
        title="Bind Memory"
        onExit={() => setFlow({ name: 'bind-select-agent' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select memory to bind"
            description={`Grant ${flow.targetAgent} access to which memory?`}
            items={memoryItems}
            selectedIndex={memoryNav.selectedIndex}
            emptyMessage="No memories available to bind. Create a memory first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select access level
  if (flow.name === 'bind-select-access') {
    return (
      <Screen
        title="Bind Memory"
        onExit={() => setFlow({ name: 'bind-select-memory', targetAgent: flow.targetAgent })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select access level"
            description={`What access should ${flow.targetAgent} have to ${flow.memoryName}?`}
            items={ACCESS_OPTIONS}
            selectedIndex={accessNav.selectedIndex}
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter env var name
  if (flow.name === 'bind-enter-envvar') {
    const defaultEnvVar = `${flow.memoryName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MEMORY_ID`;
    return (
      <Screen
        title="Bind Memory"
        onExit={() =>
          setFlow({ name: 'bind-select-access', targetAgent: flow.targetAgent, memoryName: flow.memoryName })
        }
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Environment variable name for memory ID"
            initialValue={defaultEnvVar}
            onSubmit={value => void handleBindComplete(value)}
            onCancel={() =>
              setFlow({ name: 'bind-select-access', targetAgent: flow.targetAgent, memoryName: flow.memoryName })
            }
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
        message={`Added memory: ${flow.memoryName}`}
        detail={`Memory configured for agent "${flow.ownerAgent}" in \`agentcore/agentcore.json\`.`}
        onAddAnother={onBack}
        onExit={onExit}
      />
    );
  }

  // Bind success
  if (flow.name === 'bind-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Bound memory: ${flow.memoryName}`}
        detail={`Agent "${flow.targetAgent}" now has access to memory "${flow.memoryName}".`}
        onAddAnother={onBack}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add memory"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'mode-select' });
      }}
      onExit={onExit}
    />
  );
}
