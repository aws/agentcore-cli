import { policyEnginePrimitive, policyPrimitive } from '../../../primitives/registry';
import { ErrorPrompt, SelectScreen } from '../../components';
import type { SelectableItem } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddPolicyEngineScreen } from './AddPolicyEngineScreen';
import { AddPolicyScreen } from './AddPolicyScreen';
import type { AddPolicyConfig, AddPolicyEngineConfig } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'select' }
  | { name: 'engine-wizard' }
  | { name: 'policy-wizard'; preSelectedEngine: string; isEngineDeployed: boolean; deployedGateways: Record<string, string> }
  | { name: 'engine-success'; engineName: string }
  | { name: 'policy-success'; policyName: string; engineName: string }
  | { name: 'error'; message: string };

interface AddPolicyFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddPolicyFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddPolicyFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [engineNames, setEngineNames] = useState<string[]>([]);
  const [policyNames, setPolicyNames] = useState<string[]>([]);

  // Load existing engines from disk on mount
  useEffect(() => {
    let cancelled = false;
    policyEnginePrimitive.getExistingEngines().then(names => {
      if (cancelled) return;
      setEngineNames(names);
      if (names.length === 0) {
        setFlow({ name: 'engine-wizard' });
      } else {
        setFlow({ name: 'select' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive) {
      if (flow.name === 'engine-success' || flow.name === 'policy-success') {
        onExit();
      }
    }
  }, [isInteractive, flow.name, onExit]);

  const buildEngineSelectItems = useCallback((): SelectableItem[] => {
    const items: SelectableItem[] = engineNames.map(name => ({
      id: name,
      title: name,
      description: 'Add a policy',
    }));
    items.push({
      id: '__create_new__',
      title: 'Create a new policy engine',
      spaceBefore: true,
    });
    return items;
  }, [engineNames]);

  const handleSelectEngine = useCallback(async (item: SelectableItem) => {
    if (item.id === '__create_new__') {
      setFlow({ name: 'engine-wizard' });
    } else {
      const [deployedId, deployedGateways] = await Promise.all([
        policyEnginePrimitive.getDeployedEngineId(item.id),
        policyEnginePrimitive.getDeployedGateways(),
      ]);
      setFlow({
        name: 'policy-wizard',
        preSelectedEngine: item.id,
        isEngineDeployed: deployedId !== null && Object.keys(deployedGateways).length > 0,
        deployedGateways,
      });
    }
  }, []);

  const handleEngineComplete = useCallback(async (config: AddPolicyEngineConfig) => {
    const result = await policyEnginePrimitive.add({
      name: config.name,
    });

    if (result.success) {
      setEngineNames(prev => [...prev, config.name]);
      setFlow({ name: 'engine-success', engineName: config.name });
    } else {
      setFlow({ name: 'error', message: result.error });
    }
  }, []);

  const handlePolicyComplete = useCallback(async (config: AddPolicyConfig) => {
    const result = await policyPrimitive.add({
      name: config.name,
      engine: config.engine,
      statement: config.statement,
      source: config.sourceFile || undefined,
      validationMode: config.validationMode,
    });

    if (result.success) {
      setPolicyNames(prev => [...prev, config.name]);
      setFlow({ name: 'policy-success', policyName: config.name, engineName: config.engine });
    } else {
      setFlow({ name: 'error', message: result.error });
    }
  }, []);

  const handleAddPolicyToNewEngine = useCallback(async (engineName: string) => {
    const [deployedId, deployedGateways] = await Promise.all([
      policyEnginePrimitive.getDeployedEngineId(engineName),
      policyEnginePrimitive.getDeployedGateways(),
    ]);
    setFlow({
      name: 'policy-wizard',
      preSelectedEngine: engineName,
      isEngineDeployed: deployedId !== null && Object.keys(deployedGateways).length > 0,
      deployedGateways,
    });
  }, []);

  // Loading
  if (flow.name === 'loading') {
    return (
      <Box>
        <Text dimColor>Loading policy engines...</Text>
      </Box>
    );
  }

  // Engine select / create picker
  if (flow.name === 'select') {
    return (
      <SelectScreen title="Add Policy" items={buildEngineSelectItems()} onSelect={handleSelectEngine} onExit={onBack} />
    );
  }

  // Policy Engine wizard
  if (flow.name === 'engine-wizard') {
    return (
      <AddPolicyEngineScreen
        existingEngineNames={engineNames}
        onComplete={handleEngineComplete}
        onExit={() => {
          if (engineNames.length === 0) {
            onBack();
          } else {
            setFlow({ name: 'select' });
          }
        }}
      />
    );
  }

  // Policy wizard
  if (flow.name === 'policy-wizard') {
    return (
      <AddPolicyScreen
        existingPolicyNames={policyNames}
        existingEngineNames={engineNames}
        preSelectedEngine={flow.preSelectedEngine}
        isEngineDeployed={flow.isEngineDeployed}
        deployedGateways={flow.deployedGateways}
        onComplete={handlePolicyComplete}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  // Engine success
  if (flow.name === 'engine-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added policy engine: ${flow.engineName}`}
        detail="Policy engine added to project config. Deploy with `agentcore deploy` to create it in AWS."
        summary={
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Added:</Text>
            <Box marginLeft={2} flexDirection="column">
              <Text>
                agentcore/agentcore.json{'  '}
                <Text dimColor>Policy engine config added</Text>
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text color="yellow">
                Note: Once deployed and attached to a gateway, all tool calls become default deny.
              </Text>
            </Box>
            <Box>
              <Text color="yellow">You must add permit policies to allow agent tool access.</Text>
            </Box>
            <Box marginTop={1}>
              <Text color="yellow">
                Note: Natural language policy generation requires a deployed engine. Run `agentcore deploy` before
                using the Generate option.
              </Text>
            </Box>
            <Box marginBottom={1} />
          </Box>
        }
        onAddAnother={() => handleAddPolicyToNewEngine(flow.engineName)}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Policy success
  if (flow.name === 'policy-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added policy: ${flow.policyName}`}
        detail={`Policy added to engine '${flow.engineName}'. Deploy with \`agentcore deploy\` to apply.`}
        summary={
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Added:</Text>
            <Box marginLeft={2} flexDirection="column">
              <Text>
                agentcore/agentcore.json{'  '}
                <Text dimColor>Cedar policy added to engine {flow.engineName}</Text>
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
      message="Failed to add policy resource"
      detail={flow.message}
      onBack={() => setFlow({ name: 'select' })}
      onExit={onExit}
    />
  );
}
