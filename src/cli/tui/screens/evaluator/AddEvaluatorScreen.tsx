import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import { EvaluatorNameSchema, isValidBedrockModelId } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddEvaluatorConfig, CustomRatingScaleType } from './types';
import {
  CUSTOM_RATING_SCALE_ID,
  DEFAULT_INSTRUCTIONS,
  EVALUATION_LEVEL_OPTIONS,
  EVALUATOR_MODEL_OPTIONS,
  EVALUATOR_STEP_LABELS,
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

function formatRatingScale(ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale']): string {
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

  const isNameStep = wizard.step === 'name';
  const isLevelStep = wizard.step === 'level';
  const isModelStep = wizard.step === 'model';
  const isModelCustomStep = wizard.step === 'model-custom';
  const isInstructionsStep = wizard.step === 'instructions';
  const isRatingScaleStep = wizard.step === 'ratingScale';
  const isRatingScaleTypeStep = wizard.step === 'ratingScale-type';
  const isRatingScaleCustomStep = wizard.step === 'ratingScale-custom';
  const isConfirmStep = wizard.step === 'confirm';

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

  const helpText =
    isLevelStep || isRatingScaleStep || isModelStep || isRatingScaleTypeStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={EVALUATOR_STEP_LABELS} />;

  return (
    <Screen title="Add Evaluator" onExit={onExit} helpText={helpText} headerContent={headerContent} exitEnabled={false}>
      <Panel fullWidth>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Evaluator name"
            initialValue={generateUniqueName('MyEvaluator', existingEvaluatorNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={EvaluatorNameSchema}
            customValidation={value => !existingEvaluatorNames.includes(value) || 'Evaluator name already exists'}
          />
        )}

        {isLevelStep && (
          <WizardSelect
            title="Evaluation level"
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

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Level', value: wizard.config.level },
              { label: 'Model', value: wizard.config.config.llmAsAJudge.model },
              {
                label: 'Instructions',
                value:
                  wizard.config.config.llmAsAJudge.instructions.length > 60
                    ? wizard.config.config.llmAsAJudge.instructions.slice(0, 60) + '...'
                    : wizard.config.config.llmAsAJudge.instructions,
              },
              { label: 'Rating Scale', value: formatRatingScale(wizard.config.config.llmAsAJudge.ratingScale) },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
