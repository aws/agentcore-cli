import { PolicyNameSchema } from '../../../../schema';
import { detectRegion } from '../../../aws';
import { getPolicyGeneration, startPolicyGeneration } from '../../../aws/policy-generation';
import { ConfirmReview, Panel, PathInput, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddPolicyConfig, PolicySourceMethod } from './types';
import { POLICY_SOURCE_METHOD_OPTIONS, POLICY_STEP_LABELS, VALIDATION_MODE_OPTIONS } from './types';
import { useAddPolicyWizard } from './useAddPolicyWizard';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface AddPolicyScreenProps {
  onComplete: (config: AddPolicyConfig) => void;
  onExit: () => void;
  existingPolicyNames: string[];
  existingEngineNames: string[];
  preSelectedEngine?: string;
  isEngineDeployed?: boolean;
  deployedGateways?: Record<string, string>;
}

export function AddPolicyScreen({
  onComplete,
  onExit,
  existingPolicyNames,
  existingEngineNames,
  preSelectedEngine,
  isEngineDeployed = false,
  deployedGateways = {},
}: AddPolicyScreenProps) {
  const wizard = useAddPolicyWizard(preSelectedEngine);

  // Generation state
  const [generatedPolicy, setGeneratedPolicy] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const skipGeneration = useRef(false);

  const engineItems: SelectableItem[] = useMemo(
    () =>
      existingEngineNames.map(name => ({
        id: name,
        title: name,
        description: 'Policy engine',
      })),
    [existingEngineNames]
  );

  const sourceMethodItems: SelectableItem[] = useMemo(
    () =>
      POLICY_SOURCE_METHOD_OPTIONS.map(opt => {
        const isGenerate = opt.id === 'generate';
        const disabled = isGenerate && !isEngineDeployed;
        return {
          id: opt.id,
          title: opt.title,
          description: disabled ? 'Deploy engine first' : opt.description,
          disabled,
        };
      }),
    [isEngineDeployed]
  );

  const gatewayItems: SelectableItem[] = useMemo(
    () =>
      Object.entries(deployedGateways).map(([name, arn]) => ({
        id: arn,
        title: name,
        description: arn.split(':').slice(-1)[0],
      })),
    [deployedGateways]
  );

  const validationModeItems = useMemo(
    () => VALIDATION_MODE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isFirstStep = wizard.currentIndex === 0;
  const goBackOrExit = isFirstStep ? onExit : () => wizard.goBack();

  const isEngineStep = wizard.step === 'engine';
  const isNameStep = wizard.step === 'name';
  const isSourceMethodStep = wizard.step === 'source-method';
  const isSourceFileStep = wizard.step === 'source-file';
  const isSourceInlineStep = wizard.step === 'source-inline';
  const isGatewayStep = wizard.step === 'source-generate-gateway';
  const isGenerateDescriptionStep = wizard.step === 'source-generate-description';
  const isGenerateLoadingStep = wizard.step === 'source-generate-loading';
  const isGenerateReviewStep = wizard.step === 'source-generate-review';
  const isValidationStep = wizard.step === 'validation-mode';
  const isConfirmStep = wizard.step === 'confirm';

  const engineNav = useListNavigation({
    items: engineItems,
    onSelect: item => wizard.setEngine(item.id),
    onExit: goBackOrExit,
    isActive: isEngineStep,
  });

  const sourceMethodNav = useListNavigation({
    items: sourceMethodItems,
    onSelect: item => {
      if ((item as SelectableItem & { disabled?: boolean }).disabled) return;
      wizard.setSourceMethod(item.id as PolicySourceMethod);
    },
    onExit: goBackOrExit,
    isActive: isSourceMethodStep,
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: goBackOrExit,
    isActive: isGatewayStep,
  });

  const validationNav = useListNavigation({
    items: validationModeItems,
    onSelect: item => wizard.setValidationMode(item.id),
    onExit: goBackOrExit,
    isActive: isValidationStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: goBackOrExit,
    isActive: isConfirmStep,
  });

  // Handle generation review: accept or go back
  const reviewItems: SelectableItem[] = useMemo(
    () => [
      { id: 'accept', title: 'Accept generated policy', description: 'Use this policy' },
      { id: 'regenerate', title: 'Regenerate', description: 'Describe again and generate a new policy' },
    ],
    []
  );

  const handleReviewSelect = useCallback(
    (item: SelectableItem) => {
      if (item.id === 'accept' && generatedPolicy) {
        wizard.setGeneratedStatement(generatedPolicy);
      } else {
        setGeneratedPolicy(null);
        setGenerationError(null);
        skipGeneration.current = true;
        wizard.goBack();
      }
    },
    [generatedPolicy, wizard]
  );

  const reviewNav = useListNavigation({
    items: reviewItems,
    onSelect: handleReviewSelect,
    onExit: () => {
      setGeneratedPolicy(null);
      setGenerationError(null);
      skipGeneration.current = true;
      wizard.goBack();
    },
    isActive: isGenerateReviewStep && !generationError,
  });

  // Real policy generation when entering the loading step
  useEffect(() => {
    if (!isGenerateLoadingStep) return undefined;
    if (skipGeneration.current) {
      skipGeneration.current = false;
      // Navigate back past the loading step to the description step.
      // This runs after React re-rendered with the loading step active,
      // so goBack() correctly sees 'source-generate-loading' as current step.
      wizard.goBack();
      return undefined;
    }

    let cancelled = false;

    async function generate() {
      try {
        const regionResult = await detectRegion();
        const region = regionResult.region;

        // policyEngineId is needed; get it from deployed state
        const { policyEnginePrimitive } = await import('../../../primitives/registry');
        const policyEngineId = await policyEnginePrimitive.getDeployedEngineId(wizard.config.engine);

        if (!policyEngineId) {
          if (!cancelled) {
            setGenerationError('Policy engine is not deployed. Run `agentcore deploy` first.');
            wizard.onGenerationComplete('');
          }
          return;
        }

        const startResult = await startPolicyGeneration({
          policyEngineId,
          description: wizard.config.naturalLanguageDescription,
          region,
          resourceArn: wizard.config.gatewayArn,
        });

        if (cancelled) return;

        const result = await getPolicyGeneration({
          generationId: startResult.generationId,
          policyEngineId,
          region,
        });

        if (cancelled) return;

        setGeneratedPolicy(result.statement);
        wizard.onGenerationComplete(result.statement);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Generation failed';
          setGenerationError(message);
          wizard.onGenerationComplete('');
        }
      }
    }

    void generate();

    return () => {
      cancelled = true;
    };
  }, [
    isGenerateLoadingStep,
    wizard.config.naturalLanguageDescription,
    wizard.config.engine,
    wizard.config.gatewayArn,
    wizard,
  ]);

  // Determine help text
  const helpText: string =
    isEngineStep || isSourceMethodStep || isValidationStep || isGenerateReviewStep || isGatewayStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : isGenerateLoadingStep
          ? HELP_TEXT.BACK
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={POLICY_STEP_LABELS} />;

  const validationModeLabel =
    wizard.config.validationMode === 'FAIL_ON_ANY_FINDINGS' ? 'Fail on any findings' : 'Ignore all findings';

  // Determine the cedar source display for confirm screen
  const cedarSourceDisplay =
    wizard.config.sourceMethod === 'file'
      ? wizard.config.sourceFile
      : wizard.config.sourceMethod === 'generate'
        ? `Generated from: "${wizard.config.naturalLanguageDescription}"`
        : '(inline statement)';

  return (
    <Screen title="Add Policy" onExit={onExit} exitEnabled={false} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isEngineStep && (
          <WizardSelect
            title="Select policy engine"
            description="Choose which policy engine to add this policy to"
            items={engineItems}
            selectedIndex={engineNav.selectedIndex}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="Policy name"
            initialValue={generateUniqueName('MyPolicy', existingPolicyNames)}
            onSubmit={wizard.setName}
            onCancel={goBackOrExit}
            schema={PolicyNameSchema}
            customValidation={value => !existingPolicyNames.includes(value) || 'Policy name already exists'}
          />
        )}

        {isSourceMethodStep && (
          <WizardSelect
            title="How would you like to define the Cedar policy?"
            description="Choose how to provide the policy statement"
            items={sourceMethodItems}
            selectedIndex={sourceMethodNav.selectedIndex}
          />
        )}

        {isSourceFileStep && (
          <PathInput
            placeholder="Path to Cedar policy file (.cedar)"
            onSubmit={wizard.setSourceFile}
            onCancel={goBackOrExit}
          />
        )}

        {isSourceInlineStep && (
          <TextInput
            key="inline-statement"
            prompt="Enter Cedar policy statement"
            initialValue=""
            expandable
            onSubmit={wizard.setInlineStatement}
            onCancel={goBackOrExit}
          />
        )}

        {isGatewayStep && (
          <WizardSelect
            title="Select a deployed gateway"
            description="Choose which gateway this policy will apply to"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {isGenerateDescriptionStep && (
          <TextInput
            key="generate-description"
            prompt="Describe your policy in natural language"
            initialValue={wizard.config.naturalLanguageDescription}
            expandable
            onSubmit={wizard.setNaturalLanguageDescription}
            onCancel={goBackOrExit}
          />
        )}

        {isGenerateLoadingStep && (
          <Box flexDirection="column">
            <Text>
              <Spinner type="dots" /> Generating Cedar policy from description...
            </Text>
            <Box marginTop={1}>
              <Text dimColor>&ldquo;{wizard.config.naturalLanguageDescription}&rdquo;</Text>
            </Box>
          </Box>
        )}

        {isGenerateReviewStep && generationError && (
          <Box flexDirection="column">
            <Text color="red">Generation failed: {generationError}</Text>
            <Box marginTop={1}>
              <Text dimColor>Press Escape to go back and try again.</Text>
            </Box>
          </Box>
        )}

        {isGenerateReviewStep && generatedPolicy && !generationError && (
          <Box flexDirection="column">
            <Text bold>Generated Cedar policy:</Text>
            <Box marginTop={1} marginBottom={1} flexDirection="column">
              {generatedPolicy.split('\n').map((line, i) => (
                <Text key={i} color="cyan">
                  {line}
                </Text>
              ))}
            </Box>
            <WizardSelect
              title="What would you like to do?"
              description=""
              items={reviewItems}
              selectedIndex={reviewNav.selectedIndex}
            />
          </Box>
        )}

        {isValidationStep && (
          <WizardSelect
            title="Validation mode"
            description="How to handle Cedar analyzer validation findings"
            items={validationModeItems}
            selectedIndex={validationNav.selectedIndex}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Engine', value: wizard.config.engine },
              { label: 'Name', value: wizard.config.name },
              { label: 'Cedar source', value: cedarSourceDisplay },
              { label: 'Validation', value: validationModeLabel },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
