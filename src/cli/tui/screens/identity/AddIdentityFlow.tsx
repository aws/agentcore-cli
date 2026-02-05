import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddIdentityScreen } from './AddIdentityScreen';
import type { AddIdentityConfig } from './types';
import { useCreateIdentity, useExistingIdentityNames } from './useCreateIdentity';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; identityName: string }
  | { name: 'error'; message: string };

interface AddIdentityFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
}

export function AddIdentityFlow({ isInteractive = true, onExit, onBack }: AddIdentityFlowProps) {
  const { createIdentity, reset: resetCreate } = useCreateIdentity();
  const { names: existingNames } = useExistingIdentityNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddIdentityConfig) => {
      void createIdentity(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', identityName: result.result.name });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createIdentity]
  );

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddIdentityScreen existingIdentityNames={existingNames} onComplete={handleCreateComplete} onExit={onBack} />
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added credential: ${flow.identityName}`}
        detail="Credential added to project in `agentcore/agentcore.json`. API key stored in `agentcore/.env`."
        onAddAnother={onBack}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add credential"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
