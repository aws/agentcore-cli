import { ErrorPrompt } from '../../components';
import { useCreateMemory, useExistingMemoryNames } from '../../hooks/useCreateMemory';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddMemoryScreen } from './AddMemoryScreen';
import type { AddMemoryConfig } from './types';
import { Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; memoryName: string }
  | { name: 'error'; message: string };

interface AddMemoryFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

const MODE_OPTIONS: SelectableItem[] = [
  { id: 'create', title: 'Create new memory', description: 'Define a new memory provider for an agent' },
  { id: 'bind', title: 'Bind existing memory', description: 'Grant another agent access to an existing memory' },
];

const ACCESS_OPTIONS: SelectableItem[] = [
  { id: 'read', title: 'Read-only', description: 'Agent can only read from memory' },
  { id: 'readwrite', title: 'Read/Write', description: 'Agent can read and write to memory' },
];

export function AddMemoryFlow({ isInteractive = true, onExit, onBack, onDeploy }: AddMemoryFlowProps) {
  const { createMemory, reset: resetCreate } = useCreateMemory();
  const { names: existingNames } = useExistingMemoryNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddMemoryConfig) => {
      void createMemory(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', memoryName: result.result.name });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createMemory]
  );

  // Create wizard
  if (flow.name === 'create-wizard') {
    return <AddMemoryScreen existingMemoryNames={existingNames} onComplete={handleCreateComplete} onExit={onBack} />;
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added memory: ${flow.memoryName}`}
        detail="Memory added to project in `agentcore/agentcore.json`."
        summary={
          <Text color="yellow">
            Note: Once you deploy, the memory resource will be created in your account, but it is not automatically
            connected to your agent. You must configure your agent code to use this memory.
          </Text>
        }
        onAddAnother={onBack}
        onDeploy={onDeploy}
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
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
