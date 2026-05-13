import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import type {
  AddEvaluatorConfig,
  AddEvaluatorStep,
  CodeBasedTypeId,
  CustomRatingScaleType,
  EvaluatorTypeId,
} from './types';
import {
  CUSTOM_MODEL_ID,
  CUSTOM_RATING_SCALE_ID,
  DEFAULT_CODE_ENTRYPOINT,
  DEFAULT_CODE_TIMEOUT,
  DEFAULT_MODEL,
} from './types';
import { useCallback, useMemo, useState } from 'react';

const LLM_STEPS: AddEvaluatorStep[] = [
  'evaluator-type',
  'name',
  'level',
  'model',
  'instructions',
  'ratingScale',
  'kms-key-arn',
  'confirm',
];
const CODE_MANAGED_STEPS: AddEvaluatorStep[] = [
  'evaluator-type',
  'code-based-type',
  'name',
  'level',
  'timeout',
  'kms-key-arn',
  'confirm',
];
const CODE_EXTERNAL_STEPS: AddEvaluatorStep[] = [
  'evaluator-type',
  'code-based-type',
  'name',
  'level',
  'lambda-arn',
  'kms-key-arn',
  'confirm',
];

function getSteps(evalType: EvaluatorTypeId, codeType: CodeBasedTypeId): AddEvaluatorStep[] {
  if (evalType === 'llm-as-a-judge') return LLM_STEPS;
  if (codeType === 'external') return CODE_EXTERNAL_STEPS;
  return CODE_MANAGED_STEPS;
}

function getDefaultLlmConfig(): EvaluatorConfig {
  return {
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
  };
}

export function useAddEvaluatorWizard() {
  const [evaluatorType, setEvaluatorType] = useState<EvaluatorTypeId>('code-based');
  const [codeBasedType, setCodeBasedType] = useState<CodeBasedTypeId>('managed');
  const [name, setNameState] = useState('');
  const [level, setLevelState] = useState<EvaluationLevel>('SESSION');
  const [llmConfig, setLlmConfig] = useState<NonNullable<EvaluatorConfig['llmAsAJudge']>>({
    model: DEFAULT_MODEL,
    instructions: '',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Poor', definition: 'Fails to meet expectations' },
        { value: 5, label: 'Excellent', definition: 'Far exceeds expectations' },
      ],
    },
  });
  const [lambdaArn, setLambdaArnState] = useState('');
  const [timeout, setTimeoutState] = useState(DEFAULT_CODE_TIMEOUT);
  const [customRatingScaleType, setCustomRatingScaleType] = useState<CustomRatingScaleType>('numerical');
  const [kmsKeyArn, setKmsKeyArnState] = useState('');
  const [step, setStep] = useState<AddEvaluatorStep>('evaluator-type');

  const steps = useMemo(() => getSteps(evaluatorType, codeBasedType), [evaluatorType, codeBasedType]);
  const currentIndex = steps.indexOf(step);

  const nextStep = useCallback(
    (currentStep: AddEvaluatorStep): AddEvaluatorStep | undefined => {
      const idx = steps.indexOf(currentStep);
      return steps[idx + 1];
    },
    [steps]
  );

  const goBack = useCallback(() => {
    // Sub-steps not in main steps array — go back to their parent select
    if (step === 'model-custom') {
      setStep('model');
      return;
    }
    if (step === 'ratingScale-type' || step === 'ratingScale-custom') {
      setStep(step === 'ratingScale-custom' ? 'ratingScale-type' : 'ratingScale');
      return;
    }
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, step, steps]);

  // Build the final config based on current state
  const config: AddEvaluatorConfig = useMemo(() => {
    const kms = kmsKeyArn || undefined;
    if (evaluatorType === 'llm-as-a-judge') {
      return {
        name,
        level,
        config: { llmAsAJudge: llmConfig },
        ...(kms && { kmsKeyArn: kms }),
      };
    }

    if (codeBasedType === 'external') {
      return {
        name,
        level,
        config: {
          codeBased: {
            external: { lambdaArn },
          },
        },
        ...(kms && { kmsKeyArn: kms }),
      };
    }

    // managed
    return {
      name,
      level,
      config: {
        codeBased: {
          managed: {
            codeLocation: `app/${name}/`,
            entrypoint: DEFAULT_CODE_ENTRYPOINT,
            timeoutSeconds: timeout,
            additionalPolicies: ['execution-role-policy.json'],
          },
        },
      },
      ...(kms && { kmsKeyArn: kms }),
    };
  }, [evaluatorType, codeBasedType, name, level, llmConfig, lambdaArn, timeout, kmsKeyArn]);

  const selectEvaluatorType = useCallback((type: EvaluatorTypeId) => {
    setEvaluatorType(type);
    if (type === 'code-based') {
      setStep('code-based-type');
    } else {
      setStep('name');
    }
  }, []);

  const selectCodeBasedType = useCallback((type: CodeBasedTypeId) => {
    setCodeBasedType(type);
    setStep('name');
  }, []);

  const setName = useCallback(
    (value: string) => {
      setNameState(value);
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setLevel = useCallback(
    (value: EvaluationLevel) => {
      setLevelState(value);
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
      setLlmConfig(c => ({ ...c, model: modelId }));
      const next = nextStep('model');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setCustomModel = useCallback(
    (model: string) => {
      setLlmConfig(c => ({ ...c, model }));
      const next = nextStep('model');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setInstructions = useCallback(
    (instructions: string) => {
      setLlmConfig(c => ({ ...c, instructions }));
      const next = nextStep('instructions');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const selectRatingScale = useCallback(
    (presetIdOrCustom: string, ratingScale?: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale']) => {
      if (presetIdOrCustom === CUSTOM_RATING_SCALE_ID) {
        setStep('ratingScale-type');
        return;
      }
      if (ratingScale) {
        setLlmConfig(c => ({ ...c, ratingScale }));
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
    (ratingScale: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale']) => {
      setLlmConfig(c => ({ ...c, ratingScale }));
      const next = nextStep('ratingScale');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setLambdaArn = useCallback(
    (arn: string) => {
      setLambdaArnState(arn);
      const next = nextStep('lambda-arn');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTimeout = useCallback(
    (value: number) => {
      setTimeoutState(value);
      const next = nextStep('timeout');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setKmsKeyArn = useCallback(
    (arn: string) => {
      setKmsKeyArnState(arn);
      const next = nextStep('kms-key-arn');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setEvaluatorType('code-based');
    setCodeBasedType('managed');
    setNameState('');
    setLevelState('SESSION');
    setLlmConfig(getDefaultLlmConfig().llmAsAJudge!);
    setLambdaArnState('');
    setTimeoutState(DEFAULT_CODE_TIMEOUT);
    setKmsKeyArnState('');
    setStep('evaluator-type');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    evaluatorType,
    codeBasedType,
    customRatingScaleType,
    goBack,
    selectEvaluatorType,
    selectCodeBasedType,
    setName,
    setLevel,
    selectModel,
    setCustomModel,
    setInstructions,
    selectRatingScale,
    selectCustomRatingScaleType,
    setCustomRatingScale,
    setLambdaArn,
    setTimeout,
    setKmsKeyArn,
    reset,
  };
}
