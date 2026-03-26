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
import type { AddOnlineEvalConfig, EvaluatorItem } from './types';
import { DEFAULT_SAMPLING_RATE, ONLINE_EVAL_STEP_LABELS } from './types';
import { useAddOnlineEvalWizard } from './useAddOnlineEvalWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddOnlineEvalScreenProps {
  onComplete: (config: AddOnlineEvalConfig) => void;
  onExit: () => void;
  existingConfigNames: string[];
  evaluatorItems: EvaluatorItem[];
  agentNames: string[];
}

export function AddOnlineEvalScreen({
  onComplete,
  onExit,
  existingConfigNames,
  evaluatorItems: rawEvaluatorItems,
  agentNames,
}: AddOnlineEvalScreenProps) {
  const wizard = useAddOnlineEvalWizard(agentNames.length);

  // Auto-set agent when there's only one
  const effectiveConfig = useMemo(() => {
    if (agentNames.length === 1 && !wizard.config.agent) {
      return { ...wizard.config, agent: agentNames[0]! };
    }
    return wizard.config;
  }, [wizard.config, agentNames]);

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
  const isAgentStep = wizard.step === 'agent';
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

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => wizard.goBack(),
    isActive: isAgentStep,
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
    : isAgentStep || isEnableOnCreateStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={ONLINE_EVAL_STEP_LABELS} />
  );

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

        {isAgentStep && (
          <WizardSelect
            title="Select agent to monitor"
            description="Each online eval config monitors a single agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
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
              prompt="Sampling rate (0.01–100%)"
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

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: effectiveConfig.name },
              { label: 'Agent', value: effectiveConfig.agent },
              { label: 'Evaluators', value: effectiveConfig.evaluators.join(', ') },
              { label: 'Sampling Rate', value: `${effectiveConfig.samplingRate}%` },
              { label: 'Enable on Deploy', value: effectiveConfig.enableOnCreate ? 'Yes' : 'No' },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
