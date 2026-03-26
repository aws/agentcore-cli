import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import type { AddEvaluatorConfig, AddEvaluatorStep, CustomRatingScaleType } from './types';
import { CUSTOM_MODEL_ID, CUSTOM_RATING_SCALE_ID, DEFAULT_MODEL } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddEvaluatorStep[] = ['name', 'level', 'model', 'instructions', 'ratingScale', 'confirm'];

function getDefaultConfig(): AddEvaluatorConfig {
  return {
    name: '',
    level: 'SESSION',
    config: {
      llmAsAJudge: {
        model: DEFAULT_MODEL,
        instructions: '',
        ratingScale: {
          numerical: [
            { value: 1, label: 'Poor', definition: 'Fails to meet expectations' },
            { value: 5, label: 'Excellent', definition: 'Far exceeds expectations' },
          ],
        },
      },
    },
  };
}

export function useAddEvaluatorWizard() {
  const [config, setConfig] = useState<AddEvaluatorConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddEvaluatorStep>('name');
  const [customRatingScaleType, setCustomRatingScaleType] = useState<CustomRatingScaleType>('numerical');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    // Sub-steps not in ALL_STEPS — go back to their parent select
    if (step === 'model-custom') {
      setStep('model');
      return;
    }
    if (step === 'ratingScale-type' || step === 'ratingScale-custom') {
      setStep(step === 'ratingScale-custom' ? 'ratingScale-type' : 'ratingScale');
      return;
    }
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, step]);

  const nextStep = useCallback((currentStep: AddEvaluatorStep): AddEvaluatorStep | undefined => {
    const idx = ALL_STEPS.indexOf(currentStep);
    return ALL_STEPS[idx + 1];
  }, []);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setLevel = useCallback(
    (level: EvaluationLevel) => {
      setConfig(c => ({ ...c, level }));
      const next = nextStep('level');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const selectModel = useCallback(
    (modelId: string) => {
      if (modelId === CUSTOM_MODEL_ID) {
        setStep('model-custom');
        return;
      }
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, model: modelId },
        },
      }));
      const next = nextStep('model');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setCustomModel = useCallback(
    (model: string) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, model },
        },
      }));
      // After custom model input, go to instructions (same as after model select)
      const next = nextStep('model');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setInstructions = useCallback(
    (instructions: string) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, instructions },
        },
      }));
      const next = nextStep('instructions');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const selectRatingScale = useCallback(
    (presetIdOrCustom: string, ratingScale?: EvaluatorConfig['llmAsAJudge']['ratingScale']) => {
      if (presetIdOrCustom === CUSTOM_RATING_SCALE_ID) {
        setStep('ratingScale-type');
        return;
      }
      if (ratingScale) {
        setConfig(c => ({
          ...c,
          config: {
            llmAsAJudge: { ...c.config.llmAsAJudge, ratingScale },
          },
        }));
      }
      const next = nextStep('ratingScale');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const selectCustomRatingScaleType = useCallback((type: CustomRatingScaleType) => {
    setCustomRatingScaleType(type);
    setStep('ratingScale-custom');
  }, []);

  const setCustomRatingScale = useCallback(
    (ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale']) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, ratingScale },
        },
      }));
      const next = nextStep('ratingScale');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps: ALL_STEPS,
    currentIndex,
    customRatingScaleType,
    goBack,
    setName,
    setLevel,
    selectModel,
    setCustomModel,
    setInstructions,
    selectRatingScale,
    selectCustomRatingScaleType,
    setCustomRatingScale,
    reset,
  };
}
