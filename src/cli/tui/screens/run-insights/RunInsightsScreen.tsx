import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { AVAILABLE_INSIGHTS, RUN_INSIGHTS_STEP_LABELS, SESSION_MODE_OPTIONS, SOURCE_OPTIONS } from './types';
import type { RunInsightsConfig } from './types';
import { useRunInsightsWizard } from './useRunInsightsWizard';
import React, { useMemo } from 'react';

interface RunInsightsScreenProps {
  agentNames: string[];
  onlineEvalConfigArns: string[];
  onComplete: (config: RunInsightsConfig) => void;
  onExit: () => void;
}

export function RunInsightsScreen({ agentNames, onlineEvalConfigArns, onComplete, onExit }: RunInsightsScreenProps) {
  const wizard = useRunInsightsWizard(agentNames.length);

  const isSourceStep = wizard.step === 'source';
  const isAgentStep = wizard.step === 'agent';
  const isInsightsStep = wizard.step === 'insights';
  const isSessionsStep = wizard.step === 'sessions';
  const isLookbackStep = wizard.step === 'lookbackDays';
  const isConfigArnStep = wizard.step === 'configArn';
  const isNameStep = wizard.step === 'name';
  const isConfirmStep = wizard.step === 'confirm';

  const sourceItems: SelectableItem[] = useMemo(
    () => SOURCE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const agentItems: SelectableItem[] = useMemo(() => agentNames.map(name => ({ id: name, title: name })), [agentNames]);

  const insightItems = useMemo(
    () => AVAILABLE_INSIGHTS.map(i => ({ id: i.id, title: i.title, description: i.description })),
    []
  );

  const sessionModeItems: SelectableItem[] = useMemo(
    () => SESSION_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const configArnItems: SelectableItem[] = useMemo(
    () => onlineEvalConfigArns.map(arn => ({ id: arn, title: arn.split('/').pop() ?? arn })),
    [onlineEvalConfigArns]
  );

  const sourceNav = useListNavigation({
    items: sourceItems,
    onSelect: item => wizard.setSource(item.id as 'agent' | 'online-eval-config'),
    onExit,
    isActive: isSourceStep,
  });

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => wizard.goBack(),
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

  const sessionModeNav = useListNavigation({
    items: sessionModeItems,
    onSelect: item => wizard.setSessionMode(item.id as 'lookback' | 'specific'),
    onExit: () => wizard.goBack(),
    isActive: isSessionsStep,
  });

  const configArnNav = useListNavigation({
    items: configArnItems,
    onSelect: item => wizard.setOnlineEvalConfigArn(item.id),
    onExit: () => wizard.goBack(),
    isActive: isConfigArnStep,
  });

  useListNavigation({
    items: [{ id: 'submit', title: 'Start insights job' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isInsightsStep
    ? 'Space toggle · Enter confirm · Esc back'
    : isNameStep || isLookbackStep
      ? 'Enter confirm · Esc back'
      : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen
      title="Run Insights"
      onExit={onExit}
      helpText={helpText}
      exitEnabled={false}
      headerContent={<StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={RUN_INSIGHTS_STEP_LABELS} />}
    >
      <Panel>
        {isSourceStep && (
          <WizardSelect
            title="Session source"
            description="Where should sessions come from?"
            items={sourceItems}
            selectedIndex={sourceNav.selectedIndex}
          />
        )}

        {isAgentStep && (
          <WizardSelect
            title="Select agent"
            description="Choose a deployed agent to diagnose"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isInsightsStep && (
          <WizardMultiSelect
            title="Select insights"
            description="Choose the type of analysis to run"
            items={insightItems}
            cursorIndex={insightsNav.cursorIndex}
            selectedIds={insightsNav.selectedIds}
          />
        )}

        {isSessionsStep && (
          <WizardSelect
            title="Sessions"
            description="How to select sessions"
            items={sessionModeItems}
            selectedIndex={sessionModeNav.selectedIndex}
          />
        )}

        {isLookbackStep && (
          <TextInput
            key="lookback"
            prompt="Lookback window (days)"
            initialValue="7"
            onSubmit={value => {
              const days = parseInt(value, 10);
              wizard.setLookbackDays(isNaN(days) || days <= 0 ? 7 : days);
            }}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isConfigArnStep && configArnItems.length > 0 && (
          <WizardSelect
            title="Online eval config"
            description="Select a deployed online eval config"
            items={configArnItems}
            selectedIndex={configArnNav.selectedIndex}
          />
        )}

        {isConfigArnStep && configArnItems.length === 0 && (
          <TextInput
            key="configArn"
            prompt="Online eval config ARN"
            onSubmit={value => wizard.setOnlineEvalConfigArn(value)}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="Job name (leave blank for auto-generated)"
            onSubmit={value => wizard.setName(value)}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={
              wizard.config.source === 'agent'
                ? [
                    { label: 'Agent', value: wizard.config.agent ?? agentNames[0] ?? '' },
                    {
                      label: 'Insights',
                      value: wizard.config.insights
                        .map(id => AVAILABLE_INSIGHTS.find(i => i.id === id)?.title ?? id)
                        .join(', '),
                    },
                    { label: 'Sessions', value: `Last ${wizard.config.lookbackDays} days` },
                    { label: 'Name', value: wizard.config.name || '(auto-generated)' },
                  ]
                : [
                    { label: 'Source', value: 'Online eval config' },
                    { label: 'Config', value: wizard.config.onlineEvalConfigArn.split('/').pop() ?? '' },
                    { label: 'Name', value: wizard.config.name || '(auto-generated)' },
                  ]
            }
          />
        )}
      </Panel>
    </Screen>
  );
}
