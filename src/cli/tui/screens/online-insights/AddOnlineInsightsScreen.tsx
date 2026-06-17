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
import type { AddOnlineInsightsConfig } from './types';
import {
  AVAILABLE_INSIGHTS,
  CLUSTERING_FREQUENCIES,
  DEFAULT_INSIGHTS_SAMPLING_RATE,
  ONLINE_INSIGHTS_STEP_LABELS,
} from './types';
import { useAddOnlineInsightsWizard } from './useAddOnlineInsightsWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddOnlineInsightsScreenProps {
  onComplete: (config: AddOnlineInsightsConfig) => void;
  onExit: () => void;
  existingConfigNames: string[];
  agentNames: string[];
}

export function AddOnlineInsightsScreen({
  onComplete,
  onExit,
  existingConfigNames,
  agentNames,
}: AddOnlineInsightsScreenProps) {
  const wizard = useAddOnlineInsightsWizard();

  // Auto-set agent when there's only one
  const effectiveConfig = useMemo(() => {
    if (agentNames.length === 1 && !wizard.config.agent) {
      return { ...wizard.config, agent: agentNames[0]! };
    }
    return wizard.config;
  }, [wizard.config, agentNames]);

  const isAgentStep = wizard.step === 'agent';
  const isInsightsStep = wizard.step === 'insights';
  const isSamplingRateStep = wizard.step === 'samplingRate';
  const isClusteringStep = wizard.step === 'clustering';
  const isNameStep = wizard.step === 'name';
  const isConfirmStep = wizard.step === 'confirm';

  const agentItems: SelectableItem[] = useMemo(() => {
    return agentNames.map(name => ({ id: name, title: name }));
  }, [agentNames]);

  const insightItems: SelectableItem[] = useMemo(() => {
    return AVAILABLE_INSIGHTS.map(i => ({
      id: i.id,
      title: i.title,
      description: i.description,
    }));
  }, []);

  const clusteringItems: SelectableItem[] = useMemo(() => {
    return CLUSTERING_FREQUENCIES.map(f => ({
      id: f.id,
      title: f.title,
      description: `Cluster insights ${f.title.toLowerCase()}`,
    }));
  }, []);

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => onExit(),
    isActive: isAgentStep,
  });

  const insightsNav = useMultiSelectNavigation({
    items: insightItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setInsights(ids),
    onExit: () => wizard.goBack(),
    isActive: isInsightsStep,
    requireSelection: true,
  });

  const clusteringNav = useMultiSelectNavigation({
    items: clusteringItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setClusteringFrequencies(ids),
    onExit: () => wizard.goBack(),
    isActive: isClusteringStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(effectiveConfig),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText =
    isInsightsStep || isClusteringStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isAgentStep
        ? HELP_TEXT.NAVIGATE_SELECT
        : isConfirmStep
          ? HELP_TEXT.CONFIRM_CANCEL
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={ONLINE_INSIGHTS_STEP_LABELS} />
  );

  return (
    <Screen
      title="Add Online Insights Config"
      onExit={onExit}
      helpText={helpText}
      exitEnabled={false}
      headerContent={headerContent}
    >
      <Panel>
        {isAgentStep && (
          <WizardSelect
            title="Select agent to monitor"
            description="Each online insights config monitors a single agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isInsightsStep && (
          <WizardMultiSelect
            title="Select insights"
            description="Choose which continuous analysis pipelines to enable"
            items={insightItems}
            cursorIndex={insightsNav.cursorIndex}
            selectedIds={insightsNav.selectedIds}
          />
        )}

        {isSamplingRateStep && (
          <Box flexDirection="column">
            <Text dimColor>
              Percentage of agent sessions to analyze. Higher rates give better coverage but increase costs.
            </Text>
            <TextInput
              key="samplingRate"
              prompt="Sampling rate (0.01–100%)"
              initialValue={String(DEFAULT_INSIGHTS_SAMPLING_RATE)}
              onChange={(value, setValue) => {
                const filtered = value.replace(/[^0-9.]/g, '');
                if (filtered !== value) setValue(filtered);
              }}
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

        {isClusteringStep && (
          <WizardMultiSelect
            title="Select clustering frequencies (optional)"
            description="Select frequencies to cluster insight results, or press Enter to skip"
            items={clusteringItems}
            cursorIndex={clusteringNav.cursorIndex}
            selectedIds={clusteringNav.selectedIds}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="Config name"
            initialValue={generateUniqueName('MyInsights', existingConfigNames)}
            onSubmit={wizard.setName}
            onCancel={() => wizard.goBack()}
            schema={OnlineEvalConfigNameSchema}
            customValidation={value => !existingConfigNames.includes(value) || 'Config name already exists'}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: effectiveConfig.name },
              { label: 'Agent', value: effectiveConfig.agent },
              { label: 'Insights', value: effectiveConfig.insights.map(i => i.split('.').pop()!).join(', ') },
              { label: 'Sampling Rate', value: `${effectiveConfig.samplingRate}%` },
              ...(effectiveConfig.clusteringFrequencies.length > 0
                ? [{ label: 'Clustering', value: effectiveConfig.clusteringFrequencies.join(', ') }]
                : []),
              { label: 'Enable on Deploy', value: 'Yes' },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
