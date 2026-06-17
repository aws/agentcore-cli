import { OnlineEvalConfigNameSchema } from '../../../../schema';
import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddOnlineEvalConfig, EvaluatorItem, OnlineEvalSource, RuntimeEndpointEntry } from './types';
import { DEFAULT_SAMPLING_RATE, ONLINE_EVAL_STEP_LABELS } from './types';
import { useAddOnlineEvalWizard } from './useAddOnlineEvalWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

/** Runtime info with endpoints, passed from the parent flow. */
export interface RuntimeInfoForEval {
  name: string;
  endpoints: RuntimeEndpointEntry[];
}

interface AddOnlineEvalScreenProps {
  onComplete: (config: AddOnlineEvalConfig) => void;
  onExit: () => void;
  existingConfigNames: string[];
  evaluatorItems: EvaluatorItem[];
  agentNames: string[];
  /** Runtime info including endpoints for the endpoint picker step. */
  runtimes?: RuntimeInfoForEval[];
}

export function AddOnlineEvalScreen({
  onComplete,
  onExit,
  existingConfigNames,
  evaluatorItems: rawEvaluatorItems,
  agentNames,
  runtimes = [],
}: AddOnlineEvalScreenProps) {
  const wizard = useAddOnlineEvalWizard(agentNames.length);

  // State for the repeating log group input
  const [logGroupEntries, setLogGroupEntries] = useState<string[]>([]);

  // Auto-set agent when there's only one and source is agentcore-runtime
  const effectiveConfig = useMemo(() => {
    if (wizard.source === 'agentcore-runtime' && agentNames.length === 1 && !wizard.config.agent) {
      return { ...wizard.config, agent: agentNames[0]! };
    }
    return wizard.config;
  }, [wizard.config, wizard.source, agentNames]);

  // Determine endpoints for the currently selected agent
  const agentEndpoints = useMemo(() => {
    const agentName = effectiveConfig.agent;
    if (!agentName) return [];
    const rt = runtimes.find(r => r.name === agentName);
    return rt?.endpoints ?? [];
  }, [effectiveConfig.agent, runtimes]);

  // Skip steps based on source selection
  const shouldSkipStep = useCallback(
    (s: string) => {
      if (s === 'endpoint' && (wizard.source === 'cloudwatch-logs' || agentEndpoints.length === 0)) return true;
      if (s === 'agent' && wizard.source === 'cloudwatch-logs') return true;
      if (s === 'logGroupNames' && wizard.source === 'agentcore-runtime') return true;
      if (s === 'serviceName' && wizard.source === 'agentcore-runtime') return true;
      return false;
    },
    [wizard.source, agentEndpoints.length]
  );

  useEffect(() => {
    wizard.setSkipCheck(shouldSkipStep);
  }, [shouldSkipStep, wizard]); // wizard.setSkipCheck is stable (useCallback with no deps)

  // Source selection items
  const sourceItems: SelectableItem[] = useMemo(
    () => [
      { id: 'agentcore-runtime', title: 'AgentCore Runtime', description: 'Monitor a managed AgentCore agent' },
      {
        id: 'cloudwatch-logs',
        title: 'CloudWatch Logs',
        description: 'Provide custom log groups for 3rd-party agents',
      },
    ],
    []
  );

  // Build endpoint picker items: DEFAULT (plain) + each endpoint
  const endpointItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = [{ id: 'DEFAULT', title: 'DEFAULT' }];
    for (const ep of agentEndpoints) {
      items.push({ id: ep.name, title: ep.name, description: `v${ep.version}` });
    }
    return items;
  }, [agentEndpoints]);

  const evaluatorItems: SelectableItem[] = useMemo(() => {
    return rawEvaluatorItems.map(e => ({
      id: e.arn,
      title: e.name,
      description: e.type === 'Builtin' ? 'Built-in evaluator' : (e.description ?? 'Custom evaluator'),
    }));
  }, [rawEvaluatorItems]);

  const agentItems: SelectableItem[] = useMemo(() => {
    return agentNames.map(name => ({ id: name, title: name }));
  }, [agentNames]);

  const isNameStep = wizard.step === 'name';
  const isSourceStep = wizard.step === 'source';
  const isAgentStep = wizard.step === 'agent';
  const isEndpointStep = wizard.step === 'endpoint';
  const isLogGroupNamesStep = wizard.step === 'logGroupNames';
  const isServiceNameStep = wizard.step === 'serviceName';
  const isEvaluatorsStep = wizard.step === 'evaluators';
  const isSamplingRateStep = wizard.step === 'samplingRate';
  const isEnableOnCreateStep = wizard.step === 'enableOnCreate';
  const isConfirmStep = wizard.step === 'confirm';

  const enableOnCreateItems: SelectableItem[] = useMemo(
    () => [
      { id: 'yes', title: 'Yes', description: 'Enable evaluation immediately after deploy' },
      { id: 'no', title: 'No', description: 'Deploy paused — enable later with `agentcore resume online-eval`' },
    ],
    []
  );

  const sourceNav = useListNavigation({
    items: sourceItems,
    onSelect: item => wizard.setSource(item.id as OnlineEvalSource),
    onExit: () => wizard.goBack(),
    isActive: isSourceStep,
  });

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => wizard.goBack(),
    isActive: isAgentStep,
  });

  const endpointNav = useListNavigation({
    items: endpointItems,
    onSelect: item => {
      // DEFAULT means no endpoint filter — store undefined
      wizard.setEndpoint(item.id === 'DEFAULT' ? undefined : item.id);
    },
    onExit: () => wizard.goBack(),
    isActive: isEndpointStep,
  });

  const evaluatorsNav = useMultiSelectNavigation({
    items: evaluatorItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setEvaluators(ids),
    onExit: () => wizard.goBack(),
    isActive: isEvaluatorsStep,
    requireSelection: true,
  });

  const enableOnCreateNav = useListNavigation({
    items: enableOnCreateItems,
    onSelect: item => wizard.setEnableOnCreate(item.id === 'yes'),
    onExit: () => wizard.goBack(),
    isActive: isEnableOnCreateStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(effectiveConfig),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isEvaluatorsStep
    ? 'Space toggle · Enter confirm · Esc back'
    : isSourceStep || isAgentStep || isEndpointStep || isEnableOnCreateStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={ONLINE_EVAL_STEP_LABELS} />
  );

  // Build confirm fields based on source
  const confirmFields = useMemo(() => {
    const fields = [{ label: 'Name', value: effectiveConfig.name }];
    if (wizard.source === 'agentcore-runtime') {
      fields.push({ label: 'Agent', value: effectiveConfig.agent });
      if (effectiveConfig.endpoint) {
        fields.push({ label: 'Endpoint', value: effectiveConfig.endpoint });
      }
    } else {
      fields.push({ label: 'Log Groups', value: (effectiveConfig.logGroupNames ?? []).join(', ') });
      if (effectiveConfig.serviceNames && effectiveConfig.serviceNames.length > 0) {
        fields.push({ label: 'Service Names', value: effectiveConfig.serviceNames.join(', ') });
      }
    }
    fields.push({ label: 'Evaluators', value: effectiveConfig.evaluators.join(', ') });
    fields.push({ label: 'Sampling Rate', value: `${effectiveConfig.samplingRate}%` });
    fields.push({ label: 'Enable on Deploy', value: effectiveConfig.enableOnCreate ? 'Yes' : 'No' });
    return fields;
  }, [effectiveConfig, wizard.source]);

  return (
    <Screen title="Add Online Eval Config" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Config name"
            initialValue={generateUniqueName('MyOnlineEval', existingConfigNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={OnlineEvalConfigNameSchema}
            customValidation={value => !existingConfigNames.includes(value) || 'Config name already exists'}
          />
        )}

        {isSourceStep && (
          <WizardSelect
            title="Select data source type"
            description="Choose how to provide CloudWatch log data for evaluation"
            items={sourceItems}
            selectedIndex={sourceNav.selectedIndex}
          />
        )}

        {isAgentStep && (
          <WizardSelect
            title="Select agent to monitor"
            description="Each online eval config monitors a single agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isEndpointStep && (
          <WizardSelect
            title="Select endpoint to monitor"
            items={endpointItems}
            selectedIndex={endpointNav.selectedIndex}
          />
        )}

        {isLogGroupNamesStep && (
          <Box flexDirection="column">
            <Text dimColor>
              Enter CloudWatch log group names (1-5). Press Enter to add each name. Submit an empty value when done.
            </Text>
            {logGroupEntries.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {logGroupEntries.map((entry, i) => (
                  <Text key={i} color="green">
                    {' '}
                    {i + 1}. {entry}
                  </Text>
                ))}
              </Box>
            )}
            <TextInput
              key={`logGroup-${logGroupEntries.length}`}
              prompt={`Log group name ${logGroupEntries.length + 1}`}
              initialValue=""
              onSubmit={value => {
                if (value === '' && logGroupEntries.length > 0) {
                  // Empty submission finalizes the list
                  wizard.setLogGroupNames(logGroupEntries);
                  setLogGroupEntries([]);
                } else if (value !== '') {
                  if (logGroupEntries.length >= 5) return;
                  setLogGroupEntries(prev => [...prev, value]);
                }
              }}
              onCancel={() => wizard.goBack()}
              customValidation={value => {
                if (value === '' && logGroupEntries.length === 0) return 'At least one log group name is required';
                if (value === '' && logGroupEntries.length > 0) return true; // allow empty to finish
                if (logGroupEntries.length >= 5) return 'Maximum 5 log group names allowed';
                return true;
              }}
            />
          </Box>
        )}

        {isServiceNameStep && (
          <Box flexDirection="column">
            <Text dimColor>Enter service names separated by spaces (optional). Leave empty to skip.</Text>
            <TextInput
              key="serviceName"
              prompt="Service names (space-separated)"
              initialValue=""
              onSubmit={value => {
                const names = value.trim() ? value.trim().split(/\s+/) : [];
                wizard.setServiceNames(names);
              }}
              onCancel={() => wizard.goBack()}
            />
          </Box>
        )}

        {isEvaluatorsStep && (
          <WizardMultiSelect
            title="Select evaluators"
            description="Choose custom and/or built-in evaluators"
            items={evaluatorItems}
            cursorIndex={evaluatorsNav.cursorIndex}
            selectedIds={evaluatorsNav.selectedIds}
          />
        )}

        {isSamplingRateStep && (
          <Box flexDirection="column">
            <Text dimColor>
              Percentage of agent requests that will be evaluated. Higher rates give better coverage but increase LLM
              costs from evaluator invocations.
            </Text>
            <TextInput
              key="samplingRate"
              prompt="Sampling rate (0.01-100%)"
              initialValue={String(DEFAULT_SAMPLING_RATE)}
              onSubmit={value => {
                const rate = parseFloat(value);
                if (isNaN(rate) || rate < 0.01 || rate > 100) return;
                wizard.setSamplingRate(rate);
              }}
              onCancel={() => wizard.goBack()}
              customValidation={value => {
                const rate = parseFloat(value);
                if (isNaN(rate)) return 'Must be a number';
                if (rate < 0.01 || rate > 100) return 'Must be between 0.01 and 100';
                return true;
              }}
            />
          </Box>
        )}

        {isEnableOnCreateStep && (
          <WizardSelect
            title="Enable on deploy?"
            description="If enabled, evaluation starts automatically after `agentcore deploy`"
            items={enableOnCreateItems}
            selectedIndex={enableOnCreateNav.selectedIndex}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
