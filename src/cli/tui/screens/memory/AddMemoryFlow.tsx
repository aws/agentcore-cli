import { ErrorPrompt } from '../../components';
import { useCreateMemory, useExistingMemoryNames } from '../../hooks/useCreateMemory';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddMemoryScreen } from './AddMemoryScreen';
import type { AddMemoryConfig } from './types';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; memoryName: string }
  | { name: 'error'; message: string };

interface AddMemoryFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects dev from success screen to run agent locally */
  onDev?: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddMemoryFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddMemoryFlowProps) {
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
          <Box flexDirection="column">
            <Text color="yellow">
              Note: See{' '}
              <Link url="https://github.com/aws/agentcore-cli/blob/main/docs/memory.md#swapping-or-changing-memory-strands">
                <Text color="cyan">docs/memory.md</Text>
              </Link>{' '}
              to learn how to connect memory to your agent.
            </Text>
            <Text color="yellow">
              Once you deploy, the memory resource will be created in your account, but it is not automatically
              connected to your agent. You must configure your agent code to use this memory.
            </Text>
          </Box>
        }
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
