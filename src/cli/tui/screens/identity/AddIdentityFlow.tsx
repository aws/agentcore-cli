import { ErrorPrompt, Panel, Screen, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useAgents, useAttachIdentity, useOwnedIdentities } from '../../hooks/useAttach';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddIdentityScreen } from './AddIdentityScreen';
import type { AddIdentityConfig } from './types';
import { useCreateIdentity, useExistingIdentityNames } from './useCreateIdentity';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'mode-select' }
  | { name: 'create-wizard' }
  | { name: 'bind-select-agent' }
  | { name: 'bind-select-identity'; targetAgent: string }
  | { name: 'bind-enter-envvar'; targetAgent: string; identityName: string }
  | { name: 'create-success'; identityName: string; ownerAgent: string }
  | { name: 'bind-success'; identityName: string; targetAgent: string }
  | { name: 'error'; message: string };

interface AddIdentityFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  /** Available agents for the create wizard */
  availableAgents: string[];
  onExit: () => void;
  onBack: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create new identity', description: 'Define a new identity provider for an agent' },
  { id: 'bind', title: 'Bind existing identity', description: 'Grant another agent access to an existing identity' },
];

export function AddIdentityFlow({ isInteractive = true, availableAgents, onExit, onBack }: AddIdentityFlowProps) {
  const { createIdentity, reset: resetCreate } = useCreateIdentity();
  const { identityNames: existingNames } = useExistingIdentityNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'mode-select' });

  // Bind flow hooks
  const { agents: allAgents, isLoading: isLoadingAgents } = useAgents();
  const { identities: ownedIdentities } = useOwnedIdentities();
  const { attach: attachIdentity } = useAttachIdentity();

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
    onSelect: item => setFlow({ name: 'bind-select-identity', targetAgent: item.id }),
    onExit: () => setFlow({ name: 'mode-select' }),
    isActive: flow.name === 'bind-select-agent',
  });

  // Identity selection for bind flow - filter out identities already owned by target agent
  const identityItems: SelectableItem[] = useMemo(() => {
    if (flow.name !== 'bind-select-identity') return [];
    return ownedIdentities
      .filter(i => i.ownerAgent !== flow.targetAgent) // Can't bind identity to its owner
      .map(i => ({
        id: i.name,
        title: i.name,
        description: `Owned by ${i.ownerAgent}`,
      }));
  }, [ownedIdentities, flow]);

  const identityNav = useListNavigation({
    items: identityItems,
    onSelect: item => {
      if (flow.name === 'bind-select-identity') {
        setFlow({ name: 'bind-enter-envvar', targetAgent: flow.targetAgent, identityName: item.id });
      }
    },
    onExit: () => setFlow({ name: 'bind-select-agent' }),
    isActive: flow.name === 'bind-select-identity',
  });

  const handleCreateComplete = useCallback(
    (config: AddIdentityConfig) => {
      void createIdentity(config).then(result => {
        if (result.ok) {
          setFlow({
            name: 'create-success',
            identityName: result.result.name,
            ownerAgent: result.result.ownerAgent,
          });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createIdentity]
  );

  const handleBindComplete = useCallback(
    async (envVarName: string) => {
      if (flow.name !== 'bind-enter-envvar') return;

      const result = await attachIdentity(flow.targetAgent, {
        identityName: flow.identityName,
        envVarName,
      });

      if (result.ok) {
        setFlow({ name: 'bind-success', identityName: flow.identityName, targetAgent: flow.targetAgent });
      } else {
        setFlow({ name: 'error', message: result.error });
      }
    },
    [flow, attachIdentity]
  );

  // Mode selection screen
  if (flow.name === 'mode-select') {
    // Check if there are owned identities to bind
    const hasIdentitiesToBind = ownedIdentities.length > 0;

    // If no identities exist to bind, skip to create
    if (!hasIdentitiesToBind) {
      return (
        <AddIdentityScreen
          existingIdentityNames={existingNames}
          availableAgents={availableAgents}
          onComplete={handleCreateComplete}
          onExit={onBack}
        />
      );
    }

    return (
      <Screen title="Add Identity" onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="What would you like to do?"
            description="Create a new identity or bind an existing one to another agent"
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
      <AddIdentityScreen
        existingIdentityNames={existingNames}
        availableAgents={availableAgents}
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
      <Screen
        title="Bind Identity"
        onExit={() => setFlow({ name: 'mode-select' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select target agent"
            description="Which agent should have access to the identity?"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
            emptyMessage="No agents defined. Add an agent first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select identity
  if (flow.name === 'bind-select-identity') {
    return (
      <Screen
        title="Bind Identity"
        onExit={() => setFlow({ name: 'bind-select-agent' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select identity to bind"
            description={`Grant ${flow.targetAgent} access to which identity?`}
            items={identityItems}
            selectedIndex={identityNav.selectedIndex}
            emptyMessage="No identities available to bind. Create an identity first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter env var name
  if (flow.name === 'bind-enter-envvar') {
    const defaultEnvVar = `${flow.identityName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CREDENTIAL_ID`;
    return (
      <Screen
        title="Bind Identity"
        onExit={() => setFlow({ name: 'bind-select-identity', targetAgent: flow.targetAgent })}
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Environment variable name for credential ID"
            initialValue={defaultEnvVar}
            onSubmit={value => void handleBindComplete(value)}
            onCancel={() => setFlow({ name: 'bind-select-identity', targetAgent: flow.targetAgent })}
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
        message={`Added identity: ${flow.identityName}`}
        detail={`Identity configured for agent "${flow.ownerAgent}" in \`agentcore/agentcore.json\`. Credentials stored in \`agentcore/.env\`.`}
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
        message={`Bound identity: ${flow.identityName}`}
        detail={`Agent "${flow.targetAgent}" now has access to identity "${flow.identityName}".`}
        onAddAnother={onBack}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add identity"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'mode-select' });
      }}
      onExit={onExit}
    />
  );
}
