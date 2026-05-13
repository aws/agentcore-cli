import { policyEnginePrimitive, policyPrimitive } from '../../../primitives/registry';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { AttachMode, ValidationMode, standardize } from '../../../telemetry/schemas/common-shapes.js';
import {
  ErrorPrompt,
  Panel,
  Screen,
  SelectScreen,
  StepIndicator,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { POLICY_ENGINE_MODE_OPTIONS } from '../mcp/types';
import { AddPolicyEngineScreen } from './AddPolicyEngineScreen';
import { AddPolicyScreen } from './AddPolicyScreen';
import type { AddPolicyConfig, AddPolicyEngineConfig } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type EngineCreationStep = 'name' | 'attach-gateways' | 'attach-mode';

const ENGINE_STEP_LABELS: Record<EngineCreationStep, string> = {
  name: 'Name',
  'attach-gateways': 'Attach Gateways',
  'attach-mode': 'Mode',
};

type FlowState =
  | { name: 'loading' }
  | { name: 'select' }
  | { name: 'engine-wizard' }
  | { name: 'attach-gateways'; engineName: string; gateways: string[] }
  | { name: 'attach-mode'; engineName: string; selectedGateways: string[]; allGateways: string[] }
  | {
      name: 'policy-wizard';
      preSelectedEngine: string;
      isEngineDeployed: boolean;
      deployedGateways: Record<string, string>;
    }
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
  const [hasUnprotectedGateways, setHasUnprotectedGateways] = useState(false);
  const [pendingEngineName, setPendingEngineName] = useState<string | undefined>();

  const engineSteps = useMemo<EngineCreationStep[]>(() => {
    const steps: EngineCreationStep[] = ['name'];
    if (hasUnprotectedGateways) {
      steps.push('attach-gateways', 'attach-mode');
    }
    return steps;
  }, [hasUnprotectedGateways]);

  // Load existing engines from disk on mount
  useEffect(() => {
    let cancelled = false;
    void Promise.all([policyEnginePrimitive.getExistingEngines(), policyEnginePrimitive.getUnprotectedGateways()]).then(
      ([names, unprotected]) => {
        if (cancelled) return;
        setEngineNames(names);
        setHasUnprotectedGateways(unprotected.length > 0);
        if (names.length === 0) {
          setFlow({ name: 'engine-wizard' });
        } else {
          setFlow({ name: 'select' });
        }
      }
    );
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
      setFlow({ name: 'loading' });
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

  const commitEngine = useCallback(async (engineName: string, gateways?: string[], mode?: 'LOG_ONLY' | 'ENFORCE') => {
    const result = await withCommandRunTelemetry(
      'add.policy-engine',
      {
        attach_gateway_count: gateways?.length ?? 0,
        attach_mode: standardize(AttachMode, mode ?? 'log_only'),
      },
      () => policyEnginePrimitive.add({ name: engineName })
    );
    if (!result.success) {
      setFlow({ name: 'error', message: result.error.message });
      return;
    }
    setEngineNames(prev => [...prev, engineName]);
    setPendingEngineName(undefined);
    if (gateways && gateways.length > 0 && mode) {
      await policyEnginePrimitive.attachToGateways(engineName, gateways, mode);
    }
    setFlow({ name: 'engine-success', engineName });
  }, []);

  const handleEngineComplete = useCallback(
    async (config: AddPolicyEngineConfig) => {
      setPendingEngineName(config.name);
      const unprotected = await policyEnginePrimitive.getUnprotectedGateways();
      if (unprotected.length > 0) {
        setFlow({ name: 'attach-gateways', engineName: config.name, gateways: unprotected });
      } else {
        void commitEngine(config.name);
      }
    },
    [commitEngine]
  );

  const handlePolicyComplete = useCallback(async (config: AddPolicyConfig) => {
    const result = await withCommandRunTelemetry(
      'add.policy',
      {
        source_type: config.sourceFile ? 'file' : config.sourceMethod === 'generate' ? 'generate' : 'statement',
        validation_mode: standardize(ValidationMode, config.validationMode ?? 'FAIL_ON_ANY_FINDINGS'),
      },
      () =>
        policyPrimitive.add({
          name: config.name,
          engine: config.engine,
          statement: config.statement,
          source: config.sourceFile || undefined,
          validationMode: config.validationMode,
        })
    );

    if (result.success) {
      setPolicyNames(prev => [...prev, config.name]);
      setFlow({ name: 'policy-success', policyName: config.name, engineName: config.engine });
    } else {
      setFlow({ name: 'error', message: result.error.message });
    }
  }, []);

  const handleAddPolicyToNewEngine = useCallback(async (engineName: string) => {
    setFlow({ name: 'loading' });
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
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  // Engine select / create picker
  if (flow.name === 'select') {
    return (
      <SelectScreen
        title="Add Policy"
        items={buildEngineSelectItems()}
        onSelect={(item: SelectableItem) => void handleSelectEngine(item)}
        onExit={onBack}
      />
    );
  }

  // Policy Engine wizard
  if (flow.name === 'engine-wizard') {
    return (
      <AddPolicyEngineScreen
        existingEngineNames={engineNames}
        initialName={pendingEngineName}
        headerContent={<StepIndicator steps={engineSteps} currentStep="name" labels={ENGINE_STEP_LABELS} />}
        onComplete={(config: AddPolicyEngineConfig) => void handleEngineComplete(config)}
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
        onComplete={(config: AddPolicyConfig) => void handlePolicyComplete(config)}
        onExit={() => setFlow({ name: 'select' })}
      />
    );
  }

  // Attach to gateways — multi-select
  if (flow.name === 'attach-gateways') {
    return (
      <AttachGatewaysScreen
        engineName={flow.engineName}
        gateways={flow.gateways}
        stepIndicator={<StepIndicator steps={engineSteps} currentStep="attach-gateways" labels={ENGINE_STEP_LABELS} />}
        onConfirm={selected => {
          if (selected.length === 0) {
            void commitEngine(flow.engineName);
          } else {
            setFlow({
              name: 'attach-mode',
              engineName: flow.engineName,
              selectedGateways: selected,
              allGateways: flow.gateways,
            });
          }
        }}
        onBack={() => setFlow({ name: 'engine-wizard' })}
      />
    );
  }

  // Attach to gateways — mode select
  if (flow.name === 'attach-mode') {
    return (
      <AttachModeScreen
        engineName={flow.engineName}
        gatewayCount={flow.selectedGateways.length}
        stepIndicator={<StepIndicator steps={engineSteps} currentStep="attach-mode" labels={ENGINE_STEP_LABELS} />}
        onSelect={mode => {
          void commitEngine(flow.engineName, flow.selectedGateways, mode).catch(err =>
            setFlow({
              name: 'error',
              message: err instanceof Error ? err.message : 'Failed to attach policy engine',
            })
          );
        }}
        onBack={() => {
          setFlow({ name: 'attach-gateways', engineName: flow.engineName, gateways: flow.allGateways });
        }}
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
                Note: Natural language policy generation requires a deployed engine. Run `agentcore deploy` before using
                the Generate option.
              </Text>
            </Box>
            <Box marginBottom={1} />
          </Box>
        }
        onAddAnother={() => void handleAddPolicyToNewEngine(flow.engineName)}
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

function AttachGatewaysScreen({
  engineName,
  gateways,
  onConfirm,
  onBack,
  stepIndicator,
}: {
  engineName: string;
  gateways: string[];
  onConfirm: (selected: string[]) => void;
  onBack: () => void;
  stepIndicator?: React.ReactNode;
}) {
  const items: SelectableItem[] = useMemo(() => gateways.map(name => ({ id: name, title: name })), [gateways]);

  const nav = useMultiSelectNavigation({
    items,
    getId: item => item.id,
    onConfirm: ids => onConfirm([...ids]),
    onExit: onBack,
    isActive: true,
    requireSelection: false,
  });

  return (
    <Screen
      title="Attach Policy Engine"
      onExit={onBack}
      helpText="Space toggle · Enter confirm · Esc back · Ctrl+C quit"
      headerContent={stepIndicator}
    >
      <Panel>
        <WizardMultiSelect
          title={`Attach "${engineName}" to gateways`}
          description="These gateways have no policy engine. Select which ones to protect."
          items={items}
          cursorIndex={nav.cursorIndex}
          selectedIds={nav.selectedIds}
        />
      </Panel>
    </Screen>
  );
}

function AttachModeScreen({
  engineName,
  gatewayCount,
  onSelect,
  onBack,
  stepIndicator,
}: {
  engineName: string;
  gatewayCount: number;
  onSelect: (mode: 'LOG_ONLY' | 'ENFORCE') => void;
  onBack: () => void;
  stepIndicator?: React.ReactNode;
}) {
  const modeItems: SelectableItem[] = [...POLICY_ENGINE_MODE_OPTIONS];
  const nav = useListNavigation({
    items: modeItems,
    onSelect: item => onSelect(item.id as 'LOG_ONLY' | 'ENFORCE'),
    onExit: onBack,
    isActive: true,
  });

  return (
    <Screen
      title="Attach Policy Engine"
      onExit={onBack}
      helpText={HELP_TEXT.NAVIGATE_SELECT}
      headerContent={stepIndicator}
    >
      <Panel>
        <WizardSelect
          title="Select enforcement mode"
          description={`Applies to ${gatewayCount} gateway${gatewayCount > 1 ? 's' : ''} using "${engineName}"`}
          items={modeItems}
          selectedIndex={nav.selectedIndex}
        />
      </Panel>
    </Screen>
  );
}
