import { createExternalGatewayTarget } from '../../../operations/mcp/create-mcp';
import { ErrorPrompt } from '../../components';
import { useCreateGatewayTarget, useExistingGateways, useExistingToolNames } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddGatewayTargetScreen } from './AddGatewayTargetScreen';
import type { AddGatewayTargetConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; toolName: string; projectPath: string; loading?: boolean; loadingMessage?: string }
  | { name: 'error'; message: string };

interface AddGatewayTargetFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects dev from success screen to run agent locally */
  onDev?: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddGatewayTargetFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddGatewayTargetFlowProps) {
  const { createTool, reset: resetCreate } = useCreateGatewayTarget();
  const { gateways: existingGateways } = useExistingGateways();
  const { toolNames: existingToolNames } = useExistingToolNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success' && !flow.loading) {
      onExit();
    }
  }, [isInteractive, flow, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddGatewayTargetConfig) => {
      setFlow({
        name: 'create-success',
        toolName: config.name,
        projectPath: '',
        loading: true,
        loadingMessage: 'Creating gateway target...',
      });

      if (config.source === 'existing-endpoint') {
        void createExternalGatewayTarget(config)
          .then((result: { toolName: string; projectPath: string }) => {
            setFlow({ name: 'create-success', toolName: result.toolName, projectPath: result.projectPath });
          })
          .catch((err: unknown) => {
            setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
          });
      } else {
        void createTool(config).then(result => {
          if (result.ok) {
            const { toolName, projectPath } = result.result;
            setFlow({ name: 'create-success', toolName, projectPath });
            return;
          }
          setFlow({ name: 'error', message: result.error });
        });
      }
    },
    [createTool]
  );

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddGatewayTargetScreen
        existingGateways={existingGateways}
        existingToolNames={existingToolNames}
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
        message={`Added gateway target: ${flow.toolName}`}
        detail={`Project created at ${flow.projectPath}`}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        showDevOption={true}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add gateway target"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
