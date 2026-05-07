import type { VariantConfig } from './VariantConfigForm';
import type { ABTestMode, AddABTestConfig, AddABTestStep, GatewayChoice, TargetInfo } from './types';
import { useCallback, useRef, useState } from 'react';

const CONFIG_BUNDLE_STEPS: AddABTestStep[] = [
  'mode',
  'name',
  'description',
  'gateway',
  'agent',
  'variants',
  'onlineEval',
  'maxDuration',
  'enableOnCreate',
  'confirm',
];

const TARGET_BASED_STEPS: AddABTestStep[] = [
  'mode',
  'name',
  'description',
  'gateway',
  'controlTarget',
  'treatmentTarget',
  'weights',
  'evalSelect',
  'enableOnCreate',
  'confirm',
];

function getDefaultConfig(): AddABTestConfig {
  return {
    mode: 'config-bundle',
    name: '',
    description: '',
    agent: '',
    gatewayChoice: { type: 'create-new' },
    controlBundle: '',
    controlVersion: '',
    treatmentBundle: '',
    treatmentVersion: '',
    treatmentWeight: 20,
    onlineEval: '',
    // Target-based mode fields
    gateway: '',
    gatewayIsNew: false,
    controlTargetInfo: null,
    controlTargetIsNew: false,
    treatmentTargetInfo: null,
    treatmentTargetIsNew: false,
    // Legacy target-based fields
    runtime: '',
    controlTarget: '',
    controlEndpoint: '',
    treatmentTarget: '',
    treatmentEndpoint: '',
    controlWeight: 90,
    controlOnlineEval: '',
    treatmentOnlineEval: '',
    evaluators: [],
    samplingRate: 10,
    maxDuration: undefined,
    enableOnCreate: true,
  };
}

export type StepSkipCheck = (step: AddABTestStep) => boolean;

export function useAddABTestWizard() {
  const [config, setConfig] = useState<AddABTestConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddABTestStep>('mode');
  const skipCheckRef = useRef<StepSkipCheck>(() => false);

  const getSteps = useCallback((): AddABTestStep[] => {
    return config.mode === 'target-based' ? TARGET_BASED_STEPS : CONFIG_BUNDLE_STEPS;
  }, [config.mode]);

  const currentIndex = getSteps().indexOf(step);

  const setSkipCheck = useCallback((check: StepSkipCheck) => {
    skipCheckRef.current = check;
  }, []);

  const goBack = useCallback(() => {
    const steps = getSteps();
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (!skipCheckRef.current(steps[i]!)) {
        setStep(steps[i]!);
        return;
      }
    }
  }, [currentIndex, getSteps]);

  const nextStep = useCallback(
    (currentStepName: AddABTestStep): AddABTestStep | undefined => {
      const steps = getSteps();
      const idx = steps.indexOf(currentStepName);
      for (let i = idx + 1; i < steps.length; i++) {
        if (!skipCheckRef.current(steps[i]!)) {
          return steps[i]!;
        }
      }
      return undefined;
    },
    [getSteps]
  );

  const advance = useCallback(
    (from: AddABTestStep) => {
      const next = nextStep(from);
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMode = useCallback(
    (mode: ABTestMode) => {
      setConfig(c => ({ ...c, mode }));
      advance('mode');
    },
    [advance]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      advance('name');
    },
    [advance]
  );

  const setDescription = useCallback(
    (description: string) => {
      setConfig(c => ({ ...c, description }));
      advance('description');
    },
    [advance]
  );

  const setAgent = useCallback(
    (agent: string) => {
      setConfig(c => ({ ...c, agent }));
      advance('agent');
    },
    [advance]
  );

  const setGateway = useCallback(
    (gatewayChoice: GatewayChoice) => {
      setConfig(c => ({
        ...c,
        gatewayChoice,
        gateway: gatewayChoice.type === 'existing-http' ? gatewayChoice.name : '',
        gatewayIsNew: gatewayChoice.type === 'create-new',
      }));
      advance('gateway');
    },
    [advance]
  );

  const setGatewayWithName = useCallback(
    (gatewayName: string, isNew: boolean) => {
      const gatewayChoice: GatewayChoice = isNew
        ? { type: 'create-new' }
        : { type: 'existing-http', name: gatewayName };
      setConfig(c => ({
        ...c,
        gatewayChoice,
        gateway: gatewayName,
        gatewayIsNew: isNew,
      }));
      advance('gateway');
    },
    [advance]
  );

  const setVariants = useCallback(
    (variantConfig: VariantConfig) => {
      setConfig(c => ({
        ...c,
        controlBundle: variantConfig.controlBundle,
        controlVersion: variantConfig.controlVersion,
        treatmentBundle: variantConfig.treatmentBundle,
        treatmentVersion: variantConfig.treatmentVersion,
        treatmentWeight: variantConfig.treatmentWeight,
      }));
      advance('variants');
    },
    [advance]
  );

  const setOnlineEval = useCallback(
    (onlineEval: string) => {
      setConfig(c => ({ ...c, onlineEval }));
      advance('onlineEval');
    },
    [advance]
  );

  // Target-based mode setters

  const setControlTarget = useCallback(
    (target: TargetInfo, isNew: boolean) => {
      setConfig(c => ({
        ...c,
        controlTargetInfo: target,
        controlTargetIsNew: isNew,
        controlTarget: target.name,
        controlEndpoint: target.qualifier,
        runtime: target.runtimeRef,
      }));
      advance('controlTarget');
    },
    [advance]
  );

  const setTreatmentTarget = useCallback(
    (target: TargetInfo, isNew: boolean) => {
      setConfig(c => ({
        ...c,
        treatmentTargetInfo: target,
        treatmentTargetIsNew: isNew,
        treatmentTarget: target.name,
        treatmentEndpoint: target.qualifier,
        // Keep runtime from control if already set, otherwise use treatment's
        runtime: c.runtime || target.runtimeRef,
      }));
      advance('treatmentTarget');
    },
    [advance]
  );

  const setWeights = useCallback(
    (controlWeight: number, treatmentWeight: number) => {
      setConfig(c => ({ ...c, controlWeight, treatmentWeight }));
      advance('weights');
    },
    [advance]
  );

  const setEvalPath = useCallback(
    (path: 'select' | 'create') => {
      if (path === 'select') {
        advance('evalPath');
      } else {
        // Skip evalSelect, go to evalCreate
        setStep('evalCreate');
      }
    },
    [advance]
  );

  const setEvalSelect = useCallback(
    (controlEval: string, treatmentEval: string) => {
      setConfig(c => ({ ...c, controlOnlineEval: controlEval, treatmentOnlineEval: treatmentEval }));
      advance('evalSelect');
    },
    [advance]
  );

  const setEvaluators = useCallback(
    (evaluators: string[]) => {
      setConfig(c => ({ ...c, evaluators }));
      advance('evalCreate');
    },
    [advance]
  );

  const setSamplingRate = useCallback(
    (samplingRate: number) => {
      setConfig(c => ({ ...c, samplingRate }));
      advance('evalSamplingRate');
    },
    [advance]
  );

  const setMaxDuration = useCallback(
    (maxDuration: number | undefined) => {
      setConfig(c => ({ ...c, maxDuration }));
      advance('maxDuration');
    },
    [advance]
  );

  const setEnableOnCreate = useCallback(
    (enableOnCreate: boolean) => {
      setConfig(c => ({ ...c, enableOnCreate }));
      advance('enableOnCreate');
    },
    [advance]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('mode');
  }, []);

  return {
    config,
    step,
    steps: getSteps(),
    currentIndex,
    goBack,
    setSkipCheck,
    setMode,
    setName,
    setDescription,
    setAgent,
    setGateway,
    setGatewayWithName,
    setVariants,
    setOnlineEval,
    setControlTarget,
    setTreatmentTarget,
    setWeights,
    setEvalPath,
    setEvalSelect,
    setEvaluators,
    setSamplingRate,
    setMaxDuration,
    setEnableOnCreate,
    reset,
  };
}
