import { ConfigBundleNameSchema } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddConfigBundleConfig, ComponentType, DeployedComponent } from './types';
import { COMPONENT_TYPE_OPTIONS, CONFIG_BUNDLE_STEP_LABELS } from './types';
import { useAddConfigBundleWizard } from './useAddConfigBundleWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddConfigBundleScreenProps {
  onComplete: (config: AddConfigBundleConfig) => void;
  onExit: () => void;
  existingBundleNames: string[];
  deployedComponents: DeployedComponent[];
}

function validateConfigJson(value: string): string | true {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'Must be a JSON object with key-value pairs';
    }
    return true;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return 'Invalid JSON syntax';
    }
    return 'Must be a valid JSON object';
  }
}

export function AddConfigBundleScreen({
  onComplete,
  onExit,
  existingBundleNames,
  deployedComponents,
}: AddConfigBundleScreenProps) {
  const wizard = useAddConfigBundleWizard();

  const componentTypeItems: SelectableItem[] = useMemo(
    () => COMPONENT_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  // Filter deployed components by selected type
  const availableComponents: SelectableItem[] = useMemo(() => {
    const filtered = deployedComponents.filter(c => c.type === wizard.config.currentComponentType);
    // Exclude already-added ARNs
    const existingArns = new Set(Object.keys(wizard.config.components));
    return filtered
      .filter(c => !existingArns.has(c.arn))
      .map(c => ({
        id: c.arn,
        title: c.name,
        description: c.isPlaceholder ? '(not yet deployed — ARN resolved on deploy)' : c.arn,
      }));
  }, [deployedComponents, wizard.config.currentComponentType, wizard.config.components]);

  const addAnotherItems: SelectableItem[] = useMemo(
    () => [
      { id: 'no', title: 'Continue' },
      { id: 'yes', title: 'Add another component' },
    ],
    []
  );

  const isNameStep = wizard.step === 'name';
  const isDescriptionStep = wizard.step === 'description';
  const isComponentTypeStep = wizard.step === 'componentType';
  const isComponentSelectStep = wizard.step === 'componentSelect';
  const isConfigurationStep = wizard.step === 'configuration';
  const isAddAnotherStep = wizard.step === 'addAnother';
  const isBranchNameStep = wizard.step === 'branchName';
  const isCommitMessageStep = wizard.step === 'commitMessage';
  const isConfirmStep = wizard.step === 'confirm';

  const componentTypeNav = useListNavigation({
    items: componentTypeItems,
    onSelect: item => wizard.setComponentType(item.id as ComponentType),
    onExit: () => wizard.goBack(),
    isActive: isComponentTypeStep,
  });

  const componentSelectNav = useListNavigation({
    items: availableComponents,
    onSelect: item => wizard.setSelectedComponent(item.id),
    onExit: () => wizard.goBack(),
    isActive: isComponentSelectStep,
  });

  const addAnotherNav = useListNavigation({
    items: addAnotherItems,
    onSelect: item => {
      if (item.id === 'yes') wizard.addAnotherComponent();
      else wizard.doneAddingComponents();
    },
    onExit: () => wizard.goBack(),
    isActive: isAddAnotherStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText =
    isComponentTypeStep || isComponentSelectStep || isAddAnotherStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={CONFIG_BUNDLE_STEP_LABELS} />
  );

  const componentCount = Object.keys(wizard.config.components).length;

  return (
    <Screen
      title="Add Configuration Bundle"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={false}
    >
      <Panel fullWidth>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Bundle name"
            initialValue={generateUniqueName('MyBundle', existingBundleNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={ConfigBundleNameSchema}
            customValidation={value => !existingBundleNames.includes(value) || 'Bundle name already exists'}
          />
        )}

        {isDescriptionStep && (
          <TextInput
            key="description"
            prompt="Description (optional, press Enter to skip)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setDescription}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isComponentTypeStep && (
          <WizardSelect
            title="What do you want to configure?"
            description={
              componentCount > 0
                ? `${componentCount} component(s) added. Select another type or go back to continue.`
                : 'Select the type of resource to add to this bundle'
            }
            items={componentTypeItems}
            selectedIndex={componentTypeNav.selectedIndex}
          />
        )}

        {isComponentSelectStep && availableComponents.length > 0 && (
          <WizardSelect
            title={`Select a deployed ${wizard.config.currentComponentType}`}
            description="Choose from your deployed resources"
            items={availableComponents}
            selectedIndex={componentSelectNav.selectedIndex}
          />
        )}

        {isComponentSelectStep && availableComponents.length === 0 && (
          <Box flexDirection="column">
            <Text color="yellow">
              No deployed {wizard.config.currentComponentType === 'runtime' ? 'runtimes' : 'gateways'} found.
            </Text>
            <Text dimColor>Deploy your resources first with `agentcore deploy`, then try again.</Text>
            <Text dimColor>Press Esc to go back.</Text>
          </Box>
        )}

        {isConfigurationStep && (
          <>
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                <Text bold>Component:</Text> {wizard.config.currentComponentArn}
              </Text>
              <Text dimColor>Enter the configuration as a JSON object (key-value pairs).</Text>
              <Text dimColor>Example: {'{"systemPrompt": "You are a helpful assistant", "temperature": 0.7}'}</Text>
            </Box>
            <TextInput
              key={`config-${wizard.config.currentComponentArn}`}
              prompt="Configuration (JSON)"
              placeholder='{"key": "value"}'
              initialValue=""
              expandable
              onSubmit={value => {
                const parsed = JSON.parse(value) as Record<string, unknown>;
                wizard.setConfiguration(parsed);
              }}
              onCancel={() => wizard.goBack()}
              customValidation={validateConfigJson}
            />
          </>
        )}

        {isAddAnotherStep && (
          <>
            <Box flexDirection="column" marginBottom={1}>
              <Text color="green">
                {componentCount} component{componentCount !== 1 ? 's' : ''} configured:
              </Text>
              {Object.keys(wizard.config.components).map(arn => (
                <Text key={arn} dimColor>
                  {'  '}• {arn}
                </Text>
              ))}
            </Box>
            <WizardSelect
              title="Add another component?"
              items={addAnotherItems}
              selectedIndex={addAnotherNav.selectedIndex}
            />
          </>
        )}

        {isBranchNameStep && (
          <TextInput
            key="branchName"
            prompt="Branch name (press Enter for default)"
            placeholder="main"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setBranchName}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isCommitMessageStep && (
          <TextInput
            key="commitMessage"
            prompt="Commit message (press Enter for default)"
            placeholder={`Create ${wizard.config.name}`}
            initialValue=""
            allowEmpty
            onSubmit={wizard.setCommitMessage}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              ...(wizard.config.description ? [{ label: 'Description', value: wizard.config.description }] : []),
              { label: 'Components', value: `${componentCount} component(s)` },
              ...Object.entries(wizard.config.components).map(([arn, comp]) => ({
                label: `  ${arn.split('/').pop() ?? arn}`,
                value: Object.keys(comp.configuration).join(', '),
              })),
              { label: 'Branch', value: wizard.config.branchName || 'mainline' },
              { label: 'Message', value: wizard.config.commitMessage || `Create ${wizard.config.name}` },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
