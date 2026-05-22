import { datasetPrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import type { AddDatasetConfig } from './AddDatasetScreen';
import { AddDatasetScreen } from './AddDatasetScreen';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; datasetName: string; schemaType: string; location: string; description?: string }
  | { name: 'error'; message: string };

interface AddDatasetFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddDatasetFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddDatasetFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });
  const [existingNames, setExistingNames] = useState<string[]>([]);

  useEffect(() => {
    void datasetPrimitive.getAllNames().then(setExistingNames);
  }, []);

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback((config: AddDatasetConfig) => {
    void datasetPrimitive
      .add({ name: config.name, schemaType: config.schemaType, description: config.description })
      .then(result => {
        if (result.success) {
          setFlow({
            name: 'create-success',
            datasetName: result.datasetName,
            schemaType: config.schemaType,
            location: result.location,
            description: config.description,
          });
          return;
        }
        setFlow({ name: 'error', message: result.error.message });
      });
  }, []);

  // Create wizard
  if (flow.name === 'create-wizard') {
    return <AddDatasetScreen existingDatasetNames={existingNames} onComplete={handleCreateComplete} onExit={onBack} />;
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added dataset: ${flow.datasetName}`}
        detail=""
        summary={
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor> Schema: {flow.schemaType}</Text>
            <Text dimColor> File: {flow.location}</Text>
            {flow.description && <Text dimColor> Desc: {flow.description}</Text>}
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow">Next steps:</Text>
              <Text>
                {' '}
                1. Please replace sample examples in <Text color="cyan">{flow.location}</Text> with your own dataset
                examples
              </Text>
              <Text>
                {' '}
                2. Run <Text color="cyan">agentcore deploy</Text> to create the dataset and sync examples
              </Text>
            </Box>
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
      message="Failed to add dataset"
      detail={flow.message}
      onBack={() => {
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
