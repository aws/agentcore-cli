import { ErrorPrompt, Panel, Screen, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { useAgents, useAttachGateway, useGateways } from '../../hooks/useAttach';
import { useCreateGateway, useExistingGateways } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddGatewayScreen } from './AddGatewayScreen';
import type { AddGatewayConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'mode-select' }
  | { name: 'create-wizard' }
  | { name: 'bind-select-agent' }
  | { name: 'bind-select-gateway'; targetAgent: string }
  | { name: 'bind-enter-name'; targetAgent: string; gatewayName: string }
  | { name: 'bind-enter-description'; targetAgent: string; gatewayName: string; mcpProviderName: string }
  | {
      name: 'bind-enter-envvar';
      targetAgent: string;
      gatewayName: string;
      mcpProviderName: string;
      description: string;
    }
  | { name: 'create-success'; gatewayName: string; loading?: boolean; loadingMessage?: string }
  | { name: 'bind-success'; gatewayName: string; targetAgent: string }
  | { name: 'error'; message: string };

interface AddGatewayFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  /** Available agents for the create wizard */
  availableAgents: string[];
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create new gateway', description: 'Define a new gateway for your project' },
  { id: 'bind', title: 'Bind existing gateway', description: 'Attach an existing gateway to an agent' },
];

export function AddGatewayFlow({
  isInteractive = true,
  availableAgents,
  onExit,
  onBack,
  onDeploy,
}: AddGatewayFlowProps) {
  const { createGateway, reset: resetCreate } = useCreateGateway();
  const { gateways: existingGateways, refresh: refreshGateways } = useExistingGateways();
  const [flow, setFlow] = useState<FlowState>({ name: 'mode-select' });

  // Bind flow hooks
  const { agents: allAgents, isLoading: isLoadingAgents } = useAgents();
  const { gateways: bindableGateways } = useGateways();
  const { attach: attachGateway } = useAttachGateway();

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
    onSelect: item => setFlow({ name: 'bind-select-gateway', targetAgent: item.id }),
    onExit: () => setFlow({ name: 'mode-select' }),
    isActive: flow.name === 'bind-select-agent',
  });

  // Gateway selection for bind flow
  const gatewayItems: SelectableItem[] = useMemo(
    () => bindableGateways.map(name => ({ id: name, title: name })),
    [bindableGateways]
  );

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => {
      if (flow.name === 'bind-select-gateway') {
        setFlow({ name: 'bind-enter-name', targetAgent: flow.targetAgent, gatewayName: item.id });
      }
    },
    onExit: () => setFlow({ name: 'bind-select-agent' }),
    isActive: flow.name === 'bind-select-gateway',
  });

  const handleCreateComplete = useCallback(
    (config: AddGatewayConfig) => {
      setFlow({
        name: 'create-success',
        gatewayName: config.name,
        loading: true,
        loadingMessage: 'Creating gateway...',
      });
      void createGateway(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', gatewayName: result.result.name });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createGateway]
  );

  const handleBindComplete = useCallback(
    async (_envVarName: string) => {
      if (flow.name !== 'bind-enter-envvar') return;

      const result = await attachGateway();

      if (result.ok) {
        setFlow({ name: 'bind-success', gatewayName: flow.gatewayName, targetAgent: flow.targetAgent });
      } else {
        setFlow({ name: 'error', message: 'Failed to bind gateway' });
      }
    },
    [flow, attachGateway]
  );

  // Mode selection screen
  if (flow.name === 'mode-select') {
    // Check if there are gateways to bind
    const hasGatewaysToBind = bindableGateways.length > 0;

    // If no gateways exist to bind, skip to create
    if (!hasGatewaysToBind) {
      return (
        <AddGatewayScreen
          existingGateways={existingGateways}
          availableAgents={availableAgents}
          onComplete={handleCreateComplete}
          onExit={onBack}
        />
      );
    }

    return (
      <Screen title="Add Gateway" onExit={onBack} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="What would you like to do?"
            description="Create a new gateway or bind an existing one to an agent"
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
      <AddGatewayScreen
        existingGateways={existingGateways}
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
      <Screen title="Bind Gateway" onExit={() => setFlow({ name: 'mode-select' })} helpText={HELP_TEXT.NAVIGATE_SELECT}>
        <Panel>
          <WizardSelect
            title="Select target agent"
            description="Which agent should use the gateway?"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
            emptyMessage="No agents defined. Add an agent first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - select gateway
  if (flow.name === 'bind-select-gateway') {
    return (
      <Screen
        title="Bind Gateway"
        onExit={() => setFlow({ name: 'bind-select-agent' })}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
      >
        <Panel>
          <WizardSelect
            title="Select gateway to bind"
            description={`Which gateway should ${flow.targetAgent} use?`}
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
            emptyMessage="No gateways available. Create a gateway first."
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter MCP provider name
  if (flow.name === 'bind-enter-name') {
    const defaultName = `${flow.gatewayName}-provider`;
    return (
      <Screen
        title="Bind Gateway"
        onExit={() => setFlow({ name: 'bind-select-gateway', targetAgent: flow.targetAgent })}
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="MCP provider name (how this gateway appears to the agent)"
            initialValue={defaultName}
            onSubmit={value =>
              setFlow({
                name: 'bind-enter-description',
                targetAgent: flow.targetAgent,
                gatewayName: flow.gatewayName,
                mcpProviderName: value,
              })
            }
            onCancel={() => setFlow({ name: 'bind-select-gateway', targetAgent: flow.targetAgent })}
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter description
  if (flow.name === 'bind-enter-description') {
    const defaultDescription = `Tools provided by ${flow.gatewayName} gateway`;
    return (
      <Screen
        title="Bind Gateway"
        onExit={() =>
          setFlow({ name: 'bind-enter-name', targetAgent: flow.targetAgent, gatewayName: flow.gatewayName })
        }
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Description"
            initialValue={defaultDescription}
            onSubmit={value =>
              setFlow({
                name: 'bind-enter-envvar',
                targetAgent: flow.targetAgent,
                gatewayName: flow.gatewayName,
                mcpProviderName: flow.mcpProviderName,
                description: value,
              })
            }
            onCancel={() =>
              setFlow({ name: 'bind-enter-name', targetAgent: flow.targetAgent, gatewayName: flow.gatewayName })
            }
          />
        </Panel>
      </Screen>
    );
  }

  // Bind flow - enter env var name
  if (flow.name === 'bind-enter-envvar') {
    const defaultEnvVar = `${flow.mcpProviderName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
    return (
      <Screen
        title="Bind Gateway"
        onExit={() =>
          setFlow({
            name: 'bind-enter-description',
            targetAgent: flow.targetAgent,
            gatewayName: flow.gatewayName,
            mcpProviderName: flow.mcpProviderName,
          })
        }
        helpText={HELP_TEXT.TEXT_INPUT}
      >
        <Panel>
          <TextInput
            prompt="Environment variable name for gateway URL"
            initialValue={defaultEnvVar}
            onSubmit={value => void handleBindComplete(value)}
            onCancel={() =>
              setFlow({
                name: 'bind-enter-description',
                targetAgent: flow.targetAgent,
                gatewayName: flow.gatewayName,
                mcpProviderName: flow.mcpProviderName,
              })
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
        message={`Added gateway: ${flow.gatewayName}`}
        detail="Gateway defined in `agentcore/mcp.json`. Next: Use 'add tool' with 'Behind Gateway' exposure to route tools through this gateway."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={() => {
          void refreshGateways().then(() => onBack());
        }}
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
        message={`Bound gateway: ${flow.gatewayName}`}
        detail={`Agent "${flow.targetAgent}" now uses gateway "${flow.gatewayName}".`}
        onAddAnother={onBack}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add gateway"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'mode-select' });
      }}
      onExit={onExit}
    />
  );
}
