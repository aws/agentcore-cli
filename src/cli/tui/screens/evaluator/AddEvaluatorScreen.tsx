import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import { EvaluatorNameSchema, isValidBedrockModelId, isValidKmsKeyArn } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddEvaluatorConfig, CodeBasedTypeId, CustomRatingScaleType, EvaluatorTypeId } from './types';
import {
  CODE_BASED_TYPE_OPTIONS,
  CUSTOM_RATING_SCALE_ID,
  DEFAULT_CODE_TIMEOUT,
  DEFAULT_INSTRUCTIONS,
  EVALUATION_LEVEL_OPTIONS,
  EVALUATOR_MODEL_OPTIONS,
  EVALUATOR_STEP_LABELS,
  EVALUATOR_TYPE_OPTIONS,
  LEVEL_PLACEHOLDERS,
  PLACEHOLDER_DESCRIPTIONS,
  RATING_SCALE_PRESETS,
  RATING_SCALE_TYPE_OPTIONS,
  REFERENCE_INPUT_PLACEHOLDERS,
  parseCustomRatingScale,
  validateInstructionPlaceholders,
} from './types';
import { useAddEvaluatorWizard } from './useAddEvaluatorWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddEvaluatorScreenProps {
  onComplete: (config: AddEvaluatorConfig) => void;
  onExit: () => void;
  existingEvaluatorNames: string[];
}

function formatRatingScale(ratingScale: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale']): string {
  if ('numerical' in ratingScale && ratingScale.numerical) {
    return ratingScale.numerical.map(r => `${r.value}=${r.label}`).join(', ');
  }
  if ('categorical' in ratingScale && ratingScale.categorical) {
    return ratingScale.categorical.map(r => r.label).join(', ');
  }
  return 'Unknown';
}

export function AddEvaluatorScreen({ onComplete, onExit, existingEvaluatorNames }: AddEvaluatorScreenProps) {
  const wizard = useAddEvaluatorWizard();

  const evaluatorTypeItems: SelectableItem[] = useMemo(
    () => EVALUATOR_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const codeBasedTypeItems: SelectableItem[] = useMemo(
    () => CODE_BASED_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const levelItems: SelectableItem[] = useMemo(
    () => EVALUATION_LEVEL_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const ratingScaleItems: SelectableItem[] = useMemo(
    () => [
      ...RATING_SCALE_PRESETS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
      { id: CUSTOM_RATING_SCALE_ID, title: 'Custom', description: 'Define your own rating scale' },
    ],
    []
  );

  const ratingScaleTypeItems: SelectableItem[] = useMemo(
    () => RATING_SCALE_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const modelItems: SelectableItem[] = useMemo(
    () => EVALUATOR_MODEL_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isEvaluatorTypeStep = wizard.step === 'evaluator-type';
  const isCodeBasedTypeStep = wizard.step === 'code-based-type';
  const isNameStep = wizard.step === 'name';
  const isLevelStep = wizard.step === 'level';
  const isModelStep = wizard.step === 'model';
  const isModelCustomStep = wizard.step === 'model-custom';
  const isInstructionsStep = wizard.step === 'instructions';
  const isRatingScaleStep = wizard.step === 'ratingScale';
  const isRatingScaleTypeStep = wizard.step === 'ratingScale-type';
  const isRatingScaleCustomStep = wizard.step === 'ratingScale-custom';
  const isLambdaArnStep = wizard.step === 'lambda-arn';
  const isTimeoutStep = wizard.step === 'timeout';
  const isKmsKeyArnStep = wizard.step === 'kms-key-arn';
  const isConfirmStep = wizard.step === 'confirm';

  const evaluatorTypeNav = useListNavigation({
    items: evaluatorTypeItems,
    onSelect: item => wizard.selectEvaluatorType(item.id as EvaluatorTypeId),
    onExit: onExit,
    isActive: isEvaluatorTypeStep,
  });

  const codeBasedTypeNav = useListNavigation({
    items: codeBasedTypeItems,
    onSelect: item => wizard.selectCodeBasedType(item.id as CodeBasedTypeId),
    onExit: () => wizard.goBack(),
    isActive: isCodeBasedTypeStep,
  });

  const levelNav = useListNavigation({
    items: levelItems,
    onSelect: item => wizard.setLevel(item.id as EvaluationLevel),
    onExit: () => wizard.goBack(),
    isActive: isLevelStep,
  });

  const modelNav = useListNavigation({
    items: modelItems,
    onSelect: item => wizard.selectModel(item.id),
    onExit: () => wizard.goBack(),
    isActive: isModelStep,
  });

  const ratingScaleNav = useListNavigation({
    items: ratingScaleItems,
    onSelect: item => {
      const preset = RATING_SCALE_PRESETS.find(p => p.id === item.id);
      wizard.selectRatingScale(item.id, preset?.ratingScale);
    },
    onExit: () => wizard.goBack(),
    isActive: isRatingScaleStep,
  });

  const ratingScaleTypeNav = useListNavigation({
    items: ratingScaleTypeItems,
    onSelect: item => wizard.selectCustomRatingScaleType(item.id as CustomRatingScaleType),
    onExit: () => wizard.goBack(),
    isActive: isRatingScaleTypeStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const isSelectStep =
    isEvaluatorTypeStep ||
    isCodeBasedTypeStep ||
    isLevelStep ||
    isRatingScaleStep ||
    isModelStep ||
    isRatingScaleTypeStep;

  const helpText = isSelectStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={EVALUATOR_STEP_LABELS} />;

  // Build confirm fields based on evaluator type
  const confirmFields = useMemo(() => {
    const kmsField = wizard.config.kmsKeyArn ? [{ label: 'KMS Key ARN', value: wizard.config.kmsKeyArn }] : [];

    if (wizard.evaluatorType === 'llm-as-a-judge') {
      const llm = wizard.config.config.llmAsAJudge!;
      return [
        { label: 'Type', value: 'LLM-as-a-Judge' },
        { label: 'Name', value: wizard.config.name },
        { label: 'Level', value: wizard.config.level },
        { label: 'Model', value: llm.model },
        {
          label: 'Instructions',
          value: llm.instructions.length > 60 ? llm.instructions.slice(0, 60) + '...' : llm.instructions,
        },
        { label: 'Rating Scale', value: formatRatingScale(llm.ratingScale) },
        ...kmsField,
      ];
    }

    if (wizard.codeBasedType === 'managed') {
      const managed = wizard.config.config.codeBased!.managed!;
      return [
        { label: 'Type', value: 'Code-based (Managed)' },
        { label: 'Name', value: wizard.config.name },
        { label: 'Level', value: wizard.config.level },
        { label: 'Code', value: managed.codeLocation },
        { label: 'Entrypoint', value: managed.entrypoint },
        { label: 'Timeout', value: `${managed.timeoutSeconds}s` },
        ...kmsField,
      ];
    }

    // external
    const external = wizard.config.config.codeBased!.external!;
    return [
      { label: 'Type', value: 'Code-based (External)' },
      { label: 'Name', value: wizard.config.name },
      { label: 'Level', value: wizard.config.level },
      { label: 'Lambda ARN', value: external.lambdaArn },
      ...kmsField,
    ];
  }, [wizard.evaluatorType, wizard.codeBasedType, wizard.config]);

  return (
    <Screen title="Add Evaluator" onExit={onExit} helpText={helpText} headerContent={headerContent} exitEnabled={false}>
      <Panel fullWidth>
        {isEvaluatorTypeStep && (
          <WizardSelect
            title="What type of evaluator would you like to create?"
            description="Choose how to evaluate agent behavior"
            items={evaluatorTypeItems}
            selectedIndex={evaluatorTypeNav.selectedIndex}
          />
        )}

        {isCodeBasedTypeStep && (
          <WizardSelect
            title="How would you like to provide the Lambda?"
            description="Managed: CLI scaffolds and deploys. External: use existing Lambda ARN."
            items={codeBasedTypeItems}
            selectedIndex={codeBasedTypeNav.selectedIndex}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="Evaluator name"
            initialValue={generateUniqueName('MyEvaluator', existingEvaluatorNames)}
            onSubmit={wizard.setName}
            onCancel={() => wizard.goBack()}
            schema={EvaluatorNameSchema}
            customValidation={value => !existingEvaluatorNames.includes(value) || 'Evaluator name already exists'}
          />
        )}

        {isLevelStep && (
          <WizardSelect
            title="What level should this evaluator operate at?"
            description="Granularity of evaluation"
            items={levelItems}
            selectedIndex={levelNav.selectedIndex}
          />
        )}

        {isModelStep && (
          <WizardSelect
            title="Select model"
            description="Choose the LLM judge. Model availability varies by region."
            items={modelItems}
            selectedIndex={modelNav.selectedIndex}
          />
        )}

        {isModelCustomStep && (
          <TextInput
            key="model-custom"
            prompt="Bedrock model ID"
            initialValue=""
            onSubmit={wizard.setCustomModel}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              isValidBedrockModelId(value) ||
              'Must be a valid Bedrock model ID (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0) or model ARN'
            }
          />
        )}

        {isInstructionsStep && (
          <Box flexDirection="column">
            <Text>Evaluation instructions</Text>
            <Text dimColor>Available placeholders:</Text>
            {LEVEL_PLACEHOLDERS[wizard.config.level].map(p => (
              <Text key={p} dimColor>
                {'  '}
                {`{${p}}`} — {PLACEHOLDER_DESCRIPTIONS[p] ?? p}
              </Text>
            ))}
            {REFERENCE_INPUT_PLACEHOLDERS[wizard.config.level].length > 0 && (
              <>
                <Text dimColor>Reference inputs — provided by caller at eval time, may be empty:</Text>
                {REFERENCE_INPUT_PLACEHOLDERS[wizard.config.level].map(p => (
                  <Text key={p} dimColor>
                    {'  '}
                    {`{${p}}`} — {PLACEHOLDER_DESCRIPTIONS[p] ?? p}
                  </Text>
                ))}
              </>
            )}
            <TextInput
              key="instructions"
              prompt=""
              hideArrow={false}
              expandable
              initialValue={DEFAULT_INSTRUCTIONS[wizard.config.level]}
              onSubmit={wizard.setInstructions}
              onCancel={() => wizard.goBack()}
              customValidation={value => validateInstructionPlaceholders(value, wizard.config.level)}
            />
          </Box>
        )}

        {isRatingScaleStep && (
          <WizardSelect
            title="Rating scale"
            description="Choose a preset or define your own"
            items={ratingScaleItems}
            selectedIndex={ratingScaleNav.selectedIndex}
          />
        )}

        {isRatingScaleTypeStep && (
          <WizardSelect
            title="Scale type"
            description="Choose the type of custom rating scale"
            items={ratingScaleTypeItems}
            selectedIndex={ratingScaleTypeNav.selectedIndex}
          />
        )}

        {isRatingScaleCustomStep && (
          <Box flexDirection="column">
            <Text>Define rating scale entries</Text>
            <Text dimColor>
              {wizard.customRatingScaleType === 'numerical'
                ? 'Format: value:label:definition, ... (e.g. 1:Poor:Fails, 3:Good:Meets, 5:Excellent:Exceeds)'
                : 'Format: label:definition, ... (e.g. Pass:Meets criteria, Fail:Does not meet)'}
            </Text>
            <TextInput
              key="ratingScale-custom"
              prompt=""
              hideArrow={false}
              initialValue=""
              onSubmit={value => {
                const result = parseCustomRatingScale(value, wizard.customRatingScaleType);
                if (result.success) {
                  wizard.setCustomRatingScale(result.ratingScale);
                }
              }}
              onCancel={() => wizard.goBack()}
              customValidation={value => {
                const result = parseCustomRatingScale(value, wizard.customRatingScaleType);
                return result.success || result.error;
              }}
            />
          </Box>
        )}

        {isLambdaArnStep && (
          <TextInput
            key="lambda-arn"
            prompt="Lambda function ARN"
            initialValue=""
            onSubmit={wizard.setLambdaArn}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:.+$/.test(value) ||
              'Must be a valid Lambda function ARN'
            }
          />
        )}

        {isTimeoutStep && (
          <TextInput
            key="timeout"
            prompt="Lambda timeout in seconds (1-300)"
            initialValue={String(DEFAULT_CODE_TIMEOUT)}
            onSubmit={value => wizard.setTimeout(parseInt(value, 10))}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              if (isNaN(num)) return 'Must be a number';
              return (num >= 1 && num <= 300) || 'Must be between 1 and 300';
            }}
          />
        )}

        {isKmsKeyArnStep && (
          <TextInput
            key="kms-key-arn"
            prompt="KMS key ARN for encryption (optional, press Enter to skip)"
            initialValue=""
            onSubmit={wizard.setKmsKeyArn}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              value === '' ||
              isValidKmsKeyArn(value) ||
              'Must be a valid KMS key ARN (e.g. arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)'
            }
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
