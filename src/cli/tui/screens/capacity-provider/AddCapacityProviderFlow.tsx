import { capacityProviderPrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import type { AddCapacityProviderConfig } from './AddCapacityProviderScreen';
import { AddCapacityProviderScreen } from './AddCapacityProviderScreen';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; capacityProviderName: string; os: string; instanceTypes: string; description?: string }
  | { name: 'error'; message: string };

interface AddCapacityProviderFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddCapacityProviderFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddCapacityProviderFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });
  const [existingNames, setExistingNames] = useState<string[]>([]);

  useEffect(() => {
    void capacityProviderPrimitive.getAllNames().then(setExistingNames);
  }, []);

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback((config: AddCapacityProviderConfig) => {
    void capacityProviderPrimitive
      .add({
        name: config.name,
        operatorRoleArn: config.operatorRoleArn,
        description: config.description,
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        os: config.os,
        instanceTypes: config.instanceTypes,
      })
      .then(result => {
        if (result.success) {
          setFlow({
            name: 'create-success',
            capacityProviderName: result.capacityProviderName,
            os: config.os,
            instanceTypes: config.instanceTypes,
            description: config.description,
          });
          return;
        }
        setFlow({ name: 'error', message: result.error.message });
      });
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddCapacityProviderScreen existingNames={existingNames} onComplete={handleCreateComplete} onExit={onBack} />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added capacity provider: ${flow.capacityProviderName}`}
        detail="Deploy with `agentcore deploy`."
        summary={
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor> OS: {flow.os}</Text>
            <Text dimColor> Instance types: {flow.instanceTypes}</Text>
            {flow.description && <Text dimColor> Desc: {flow.description}</Text>}
          </Box>
        }
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add capacity provider"
      detail={flow.message}
      onBack={() => {
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
