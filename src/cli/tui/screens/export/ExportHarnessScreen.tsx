import { AgentNameSchema } from '../../../../schema';
import { ConfirmReview, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { useListNavigation } from '../../hooks';
import type { ExportHarnessConfig } from './types';
import { EXPORT_HARNESS_STEP_LABELS } from './types';
import { useExportHarnessWizard } from './useExportHarnessWizard';
import React from 'react';

interface ExportHarnessScreenProps {
  harnessNames: string[];
  existingAgentNames: string[];
  containerOnlyHarnesses: Set<string>;
  onComplete: (config: ExportHarnessConfig) => void;
  onExit: () => void;
}

const BUILD_ITEMS: SelectableItem[] = [
  { id: 'CodeZip', title: 'CodeZip', description: 'Package Python source as a zip artifact (default)' },
  { id: 'Container', title: 'Container', description: 'Build a Docker container image via ECR and CodeBuild' },
];

const CONFIRM_ITEM = [{ id: 'confirm', title: 'Confirm' }];

export function ExportHarnessScreen({
  harnessNames,
  existingAgentNames,
  containerOnlyHarnesses,
  onComplete,
  onExit,
}: ExportHarnessScreenProps) {
  const wizard = useExportHarnessWizard(harnessNames, onExit);
  const { config, step, steps, goBack, setHarness, setTargetAgentName, setBuild } = wizard;

  const availableBuildItems = containerOnlyHarnesses.has(config.harness)
    ? BUILD_ITEMS.filter(b => b.id === 'Container')
    : BUILD_ITEMS;

  const harnessItems: SelectableItem[] = harnessNames.map(n => ({ id: n, title: n }));

  const harnessNav = useListNavigation({
    items: harnessItems,
    onSelect: item => setHarness(item.id),
    onExit: onExit,
    isActive: step === 'select-harness',
  });

  const buildNav = useListNavigation({
    items: availableBuildItems,
    onSelect: item => setBuild(item.id as 'CodeZip' | 'Container'),
    onExit: goBack,
    isActive: step === 'build-type',
  });

  useListNavigation({
    items: CONFIRM_ITEM,
    onSelect: () => onComplete(config),
    onExit: goBack,
    isActive: step === 'confirm',
  });

  if (step === 'select-harness') {
    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={onExit}>
        <StepIndicator steps={steps} currentStep={step} labels={EXPORT_HARNESS_STEP_LABELS} />
        <WizardSelect
          title="Select harness to export"
          description="Choose the harness configuration to generate a runtime agent from"
          items={harnessItems}
          selectedIndex={harnessNav.selectedIndex}
        />
      </Screen>
    );
  }

  if (step === 'target-name') {
    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={goBack}>
        <StepIndicator steps={steps} currentStep={step} labels={EXPORT_HARNESS_STEP_LABELS} />
        <TextInput
          prompt="Runtime agent name"
          description="Name for the generated Strands runtime agent"
          initialValue={config.targetAgentName}
          onSubmit={value => {
            setTargetAgentName(value.trim());
          }}
          onCancel={goBack}
          customValidation={value => {
            const trimmed = value.trim();
            if (!trimmed) return 'Name is required';
            const parsed = AgentNameSchema.safeParse(trimmed);
            if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Invalid name';
            if (existingAgentNames.includes(trimmed)) return `Agent "${trimmed}" already exists`;
            return true;
          }}
        />
      </Screen>
    );
  }

  if (step === 'build-type') {
    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={goBack}>
        <StepIndicator steps={steps} currentStep={step} labels={EXPORT_HARNESS_STEP_LABELS} />
        <WizardSelect
          title="Build type"
          description={
            containerOnlyHarnesses.has(config.harness)
              ? 'This harness uses a custom container — only Container builds are supported'
              : 'How the agent will be packaged and deployed'
          }
          items={availableBuildItems}
          selectedIndex={buildNav.selectedIndex}
        />
      </Screen>
    );
  }

  if (step === 'confirm') {
    return (
      <Screen title="Export Harness to Python Strands Agent" onExit={goBack}>
        <StepIndicator steps={steps} currentStep={step} labels={EXPORT_HARNESS_STEP_LABELS} />
        <ConfirmReview
          title="Export configuration"
          fields={[
            { label: 'Harness', value: config.harness },
            { label: 'Runtime agent', value: config.targetAgentName },
            { label: 'Build type', value: config.build },
          ]}
          helpText="Enter to export · Esc back"
        />
      </Screen>
    );
  }

  return null;
}
