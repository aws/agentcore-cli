import { PolicyNameSchema } from '../../../../schema';
import { detectRegion } from '../../../aws';
import { getPolicyGeneration, startPolicyGeneration } from '../../../aws/policy-generation';
import { policyEnginePrimitive } from '../../../primitives/registry';
import {
  ConfirmReview,
  Panel,
  PathInput,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { synthesizeCedar } from './synthesize-cedar';
import type { AddPolicyConfig, GuardrailCategoryType, PolicyEffect, PolicySourceMethod } from './types';
import {
  ENFORCEMENT_MODE_OPTIONS,
  GUARDRAIL_CATEGORY_OPTIONS,
  POLICY_EFFECT_OPTIONS,
  POLICY_SOURCE_METHOD_OPTIONS,
  POLICY_STEP_LABELS,
  VALIDATION_MODE_OPTIONS,
  defaultDataPathForEffect,
} from './types';
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
  /** Gateways from agentcore.json with their mcpServer target names */
  projectGateways?: { name: string; httpTargets: string[] }[];
}

export function AddPolicyScreen({
  onComplete,
  onExit,
  existingPolicyNames,
  existingEngineNames,
  preSelectedEngine,
  isEngineDeployed = false,
  deployedGateways = {},
  projectGateways = [],
}: AddPolicyScreenProps) {
  const wizard = useAddPolicyWizard(preSelectedEngine, Object.keys(deployedGateways).length > 0);

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

  const isGatewaySelectStep = wizard.step === 'gateway';
  const isEngineStep = wizard.step === 'engine';
  const isNameStep = wizard.step === 'name';
  const isSourceMethodStep = wizard.step === 'source-method';
  const isSourceFileStep = wizard.step === 'source-file';
  const isSourceInlineStep = wizard.step === 'source-inline';
  const isGatewayStep = wizard.step === 'source-generate-gateway';
  const isGenerateDescriptionStep = wizard.step === 'source-generate-description';
  const isGenerateLoadingStep = wizard.step === 'source-generate-loading';
  const isGenerateReviewStep = wizard.step === 'source-generate-review';
  const isFormCategoryStep = wizard.step === 'source-form-category';
  const isFormFiltersStep = wizard.step === 'source-form-filters';
  const isFormDataPathStep = wizard.step === 'source-form-data-path';
  const isFormEffectStep = wizard.step === 'source-form-effect';
  const isFormReviewStep = wizard.step === 'source-form-review';
  const isValidationStep = wizard.step === 'validation-mode';
  const isEnforcementStep = wizard.step === 'enforcement-mode';
  const isConfirmStep = wizard.step === 'confirm';

  // ─── Standard navigation hooks ────────────────────────────────────────────────

  const hasGateways = Object.keys(deployedGateways).length > 0;

  const deployedGatewayItems: SelectableItem[] = useMemo(
    () =>
      Object.entries(deployedGateways).map(([name, arn]) => ({
        id: name,
        title: name,
        description: arn.split(':').slice(-1)[0],
      })),
    [deployedGateways]
  );

  const gatewaySelectNav = useListNavigation({
    items: deployedGatewayItems,
    onSelect: item => wizard.setGatewayForPolicy(item.id),
    onExit: goBackOrExit,
    isActive: isGatewaySelectStep && hasGateways,
  });

  // Target items based on selected gateway
  const isTargetStep = wizard.step === 'target';

  const targetItems: SelectableItem[] = useMemo(() => {
    const gw = projectGateways.find(g => g.name === wizard.config.gatewayName);
    if (!gw) return [];
    return gw.httpTargets.map(t => ({ id: t, title: t, description: 'HTTP runtime target' }));
  }, [projectGateways, wizard.config.gatewayName]);

  const targetNav = useListNavigation({
    items: targetItems,
    onSelect: item => wizard.setTargetForPolicy(item.id),
    onExit: goBackOrExit,
    isActive: isTargetStep,
  });

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

  const enforcementModeItems = useMemo(
    () => ENFORCEMENT_MODE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const enforcementNav = useListNavigation({
    items: enforcementModeItems,
    onSelect: item => wizard.setEnforcementMode(item.id),
    onExit: goBackOrExit,
    isActive: isEnforcementStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: goBackOrExit,
    isActive: isConfirmStep,
  });

  // ─── Form mode: Category select ──────────────────────────────────────────────

  const categoryItems: SelectableItem[] = useMemo(
    () =>
      GUARDRAIL_CATEGORY_OPTIONS.map(opt => ({
        id: opt.id,
        title: opt.title,
        description: opt.description,
      })),
    []
  );

  const categoryNav = useListNavigation({
    items: categoryItems,
    onSelect: item => wizard.setFormCategory(item.id as GuardrailCategoryType),
    onExit: goBackOrExit,
    isActive: isFormCategoryStep,
  });

  // ─── Form mode: Effect select (permit/forbid) ──────────────────────────────

  const effectItems: SelectableItem[] = useMemo(
    () => POLICY_EFFECT_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const effectNav = useListNavigation({
    items: effectItems,
    onSelect: item => wizard.setFormEffect(item.id as PolicyEffect),
    onExit: goBackOrExit,
    isActive: isFormEffectStep,
  });

  // ─── Form mode: Filter multi-select ───────────────────────────────────────────

  const filterItems: SelectableItem[] = useMemo(() => {
    const cat = wizard.config.guardrailForm.category;
    if (!cat) return [];
    const opt = GUARDRAIL_CATEGORY_OPTIONS.find(o => o.id === cat);
    if (!opt) return [];
    return opt.filters.map(f => ({ id: f, title: f }));
  }, [wizard.config.guardrailForm.category]);

  const filterNav = useMultiSelectNavigation({
    items: filterItems,
    getId: item => item.id,
    onConfirm: ids => {
      if (ids.length > 0) {
        wizard.setFormFilters(ids);
      }
    },
    onExit: goBackOrExit,
    isActive: isFormFiltersStep,
    requireSelection: true,
  });

  // ─── Form mode: Review ────────────────────────────────────────────────────────

  const formCedar = useMemo(() => {
    if (!isFormReviewStep) return '';
    return synthesizeCedar(wizard.config.guardrailForm, {
      targetName: wizard.config.targetName ?? undefined,
      gatewayArn: deployedGateways[wizard.config.gatewayName] ?? undefined,
    });
  }, [
    isFormReviewStep,
    wizard.config.guardrailForm,
    wizard.config.targetName,
    wizard.config.gatewayName,
    deployedGateways,
  ]);

  const formReviewItems: SelectableItem[] = useMemo(
    () => [
      { id: 'accept', title: 'Accept policy', description: 'Use this generated policy' },
      { id: 'edit', title: 'Edit selections', description: 'Go back and change filters/thresholds' },
    ],
    []
  );

  const formReviewNav = useListNavigation({
    items: formReviewItems,
    onSelect: item => {
      if (item.id === 'accept') {
        wizard.acceptFormReview(formCedar);
      } else {
        wizard.goBack();
      }
    },
    onExit: goBackOrExit,
    isActive: isFormReviewStep,
  });

  // ─── Generate mode: Review ────────────────────────────────────────────────────

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

  // ─── Generate mode: Loading effect ────────────────────────────────────────────

  useEffect(() => {
    if (!isGenerateLoadingStep) return undefined;
    if (skipGeneration.current) {
      skipGeneration.current = false;
      wizard.goBack();
      return undefined;
    }

    let cancelled = false;

    async function generate() {
      try {
        const regionResult = await detectRegion();
        const region = regionResult.region;
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

  // ─── Help text ────────────────────────────────────────────────────────────────

  const helpText: string =
    isEngineStep ||
    isSourceMethodStep ||
    isValidationStep ||
    isGenerateReviewStep ||
    isGatewayStep ||
    isFormCategoryStep ||
    isFormReviewStep ||
    isFormEffectStep ||
    isGatewaySelectStep ||
    isTargetStep ||
    isEnforcementStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isFormFiltersStep
        ? 'Space toggle · Enter confirm · Esc back'
        : isConfirmStep
          ? HELP_TEXT.CONFIRM_CANCEL
          : isGenerateLoadingStep
            ? HELP_TEXT.BACK
            : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={POLICY_STEP_LABELS} />;

  const validationModeLabel =
    wizard.config.validationMode === 'FAIL_ON_ANY_FINDINGS' ? 'Fail on any findings' : 'Ignore all findings';

  const cedarSourceDisplay =
    wizard.config.sourceMethod === 'file'
      ? wizard.config.sourceFile
      : wizard.config.sourceMethod === 'generate'
        ? `Generated from: "${wizard.config.naturalLanguageDescription}"`
        : wizard.config.sourceMethod === 'form'
          ? `Form: ${wizard.config.guardrailForm.category} (${wizard.config.guardrailForm.filters.length} filters)`
          : '(inline statement)';

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <Screen title="Add Policy" onExit={onExit} exitEnabled={false} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isGatewaySelectStep && hasGateways && (
          <WizardSelect
            title="Select a deployed gateway"
            description="Choose which gateway this policy will apply to"
            items={deployedGatewayItems}
            selectedIndex={gatewaySelectNav.selectedIndex}
          />
        )}

        {isGatewaySelectStep && !hasGateways && (
          <Box flexDirection="column">
            <Text color="red">No deployed gateways found.</Text>
            <Box marginTop={1}>
              <Text>Run `agentcore deploy` to deploy a gateway first.</Text>
            </Box>
          </Box>
        )}

        {isTargetStep && (
          <WizardSelect
            title="Select an HTTP runtime target"
            description={`Targets on gateway "${wizard.config.gatewayName}"`}
            items={targetItems}
            selectedIndex={targetNav.selectedIndex}
          />
        )}

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
            title="How would you like to define the policy?"
            description="Choose how to provide the policy statement"
            items={sourceMethodItems}
            selectedIndex={sourceMethodNav.selectedIndex}
          />
        )}

        {isSourceFileStep && (
          <PathInput
            placeholder="Path to policy file (.cedar)"
            onSubmit={wizard.setSourceFile}
            onCancel={goBackOrExit}
          />
        )}

        {isSourceInlineStep && (
          <TextInput
            key="inline-statement"
            prompt="Enter policy statement"
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
              <Spinner type="dots" /> Generating policy from description...
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
            <Text bold>Generated policy:</Text>
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

        {isFormEffectStep && (
          <WizardSelect
            title="Policy effect"
            description="Should this policy forbid or permit matching content?"
            items={effectItems}
            selectedIndex={effectNav.selectedIndex}
          />
        )}

        {isFormCategoryStep && (
          <WizardSelect
            title="Select guardrail category"
            description="Choose the type of guardrail to configure"
            items={categoryItems}
            selectedIndex={categoryNav.selectedIndex}
          />
        )}

        {isFormFiltersStep && (
          <WizardMultiSelect
            title={`Select filters for ${wizard.config.guardrailForm.category}`}
            description="Space to toggle, Enter to confirm"
            items={filterItems}
            cursorIndex={filterNav.cursorIndex}
            selectedIds={filterNav.selectedIds}
          />
        )}

        {isFormDataPathStep && (
          <TextInput
            key="form-data-path"
            prompt="Data path to evaluate (e.g. context.input.prompt, context.output.prompt)"
            initialValue={
              wizard.config.guardrailForm.dataPath || defaultDataPathForEffect(wizard.config.guardrailForm.effect)
            }
            onSubmit={wizard.setFormDataPath}
            onCancel={goBackOrExit}
          />
        )}

        {isFormReviewStep && (
          <Box flexDirection="column">
            <Text bold>Generated policy from guardrail form:</Text>
            <Box marginTop={1} marginBottom={1} flexDirection="column">
              {formCedar.split('\n').map((line, i) => (
                <Text key={i} color="cyan">
                  {line}
                </Text>
              ))}
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>Authorization phase: INITIATE (default)</Text>
            </Box>
            <WizardSelect
              title="What would you like to do?"
              description=""
              items={formReviewItems}
              selectedIndex={formReviewNav.selectedIndex}
            />
          </Box>
        )}

        {isEnforcementStep && (
          <WizardSelect
            title="Enforcement mode"
            description="Should this policy actively enforce decisions or only log them?"
            items={enforcementModeItems}
            selectedIndex={enforcementNav.selectedIndex}
          />
        )}

        {isValidationStep && (
          <WizardSelect
            title="Validation mode"
            description="How to handle analyzer validation findings"
            items={validationModeItems}
            selectedIndex={validationNav.selectedIndex}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Engine', value: wizard.config.engine },
              { label: 'Name', value: wizard.config.name },
              { label: 'Policy source', value: cedarSourceDisplay },
              { label: 'Enforcement', value: wizard.config.enforcementMode === 'ACTIVE' ? 'Active' : 'Log only' },
              { label: 'Validation', value: validationModeLabel },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
