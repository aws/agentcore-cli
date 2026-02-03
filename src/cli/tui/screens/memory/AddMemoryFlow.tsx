import { ErrorPrompt } from '../../components';
import { useAvailableAgentsForMemory, useCreateMemory, useExistingMemoryNames } from '../../hooks/useCreateMemory';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddMemoryScreen } from './AddMemoryScreen';
import type { AddMemoryConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'wizard' }
  | { name: 'success'; memoryName: string; ownerAgent: string }
  | { name: 'error'; message: string };

interface AddMemoryFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
}

export function AddMemoryFlow({ isInteractive = true, onExit, onBack }: AddMemoryFlowProps) {
  const { createMemory, reset: resetCreate } = useCreateMemory();
  const { names: existingNames } = useExistingMemoryNames();
  const { agents } = useAvailableAgentsForMemory();
  const [flow, setFlow] = useState<FlowState>({ name: 'wizard' });

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleComplete = useCallback(
    (config: AddMemoryConfig) => {
      void createMemory(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'success', memoryName: result.result.name, ownerAgent: result.result.ownerAgent });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createMemory]
  );

  if (flow.name === 'wizard') {
    // Wait for agents to load before rendering wizard
    if (agents.length === 0) {
      return null;
    }
    return (
      <AddMemoryScreen
        existingMemoryNames={existingNames}
        availableAgents={agents}
        onComplete={handleComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'success') {
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

  return (
    <ErrorPrompt
      message="Failed to add memory"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'wizard' });
      }}
      onExit={onExit}
    />
  );
}
