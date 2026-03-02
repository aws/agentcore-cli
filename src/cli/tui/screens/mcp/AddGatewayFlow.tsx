import { ErrorPrompt } from '../../components';
import { useCreateGateway, useExistingGateways, useUnassignedTargets } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddGatewayScreen } from './AddGatewayScreen';
import type { AddGatewayConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; gatewayName: string; loading?: boolean; loadingMessage?: string }
  | { name: 'error'; message: string };

interface AddGatewayFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects dev from success screen to run agent locally */
  onDev?: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddGatewayFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddGatewayFlowProps) {
  const { createGateway, reset: resetCreate } = useCreateGateway();
  const { gateways: existingGateways, refresh: refreshGateways } = useExistingGateways();
  const { targets: unassignedTargets } = useUnassignedTargets();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive) {
      if (flow.name === 'create-success' && !flow.loading) {
        onExit();
      }
    }
  }, [isInteractive, flow, onExit]);

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

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddGatewayScreen
        existingGateways={existingGateways}
        unassignedTargets={unassignedTargets}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added gateway: ${flow.gatewayName}`}
        detail="Gateway defined in `agentcore/mcp.json`. Next: Use 'add gateway-target' to route targets through this gateway."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        showDevOption={true}
        onAddAnother={() => {
          void refreshGateways().then(() => onBack());
        }}
        onDev={onDev}
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
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
