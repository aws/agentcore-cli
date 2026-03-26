import type { AddPolicyConfig, AddPolicyStep, PolicySourceMethod } from './types';
import { useCallback, useState } from 'react';

// Steps vary based on source method, but the wizard tracks the current step directly
const COMMON_PREFIX: AddPolicyStep[] = ['engine', 'name', 'source-method'];
const COMMON_SUFFIX: AddPolicyStep[] = ['validation-mode', 'confirm'];

const SOURCE_STEPS: Record<PolicySourceMethod, AddPolicyStep[]> = {
  file: ['source-file'],
  inline: ['source-inline'],
  generate: [
    'source-generate-gateway',
    'source-generate-description',
    'source-generate-loading',
    'source-generate-review',
  ],
};

function getSteps(sourceMethod: PolicySourceMethod | null, skipEngine: boolean): AddPolicyStep[] {
  const prefix = skipEngine ? COMMON_PREFIX.filter(s => s !== 'engine') : COMMON_PREFIX;
  const sourceSteps = sourceMethod ? SOURCE_STEPS[sourceMethod] : [];
  return [...prefix, ...sourceSteps, ...COMMON_SUFFIX];
}

function getDefaultConfig(preSelectedEngine?: string): AddPolicyConfig {
  return {
    name: '',
    engine: preSelectedEngine ?? '',
    sourceMethod: 'file',
    statement: '',
    sourceFile: '',
    gatewayArn: '',
    naturalLanguageDescription: '',
    validationMode: 'FAIL_ON_ANY_FINDINGS',
  };
}

export function useAddPolicyWizard(preSelectedEngine?: string) {
  const skipEngine = !!preSelectedEngine;
  const [config, setConfig] = useState<AddPolicyConfig>(() => getDefaultConfig(preSelectedEngine));
  const initialStep: AddPolicyStep = skipEngine ? 'name' : 'engine';
  const [step, setStep] = useState<AddPolicyStep>(initialStep);
  const [sourceMethod, setSourceMethodState] = useState<PolicySourceMethod | null>(null);

  const steps = getSteps(sourceMethod, skipEngine);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const allSteps = getSteps(sourceMethod, skipEngine);
    const idx = allSteps.indexOf(step);
    if (idx > 0) {
      const prevStep = allSteps[idx - 1]!;
      // If going back from a source sub-step to source-method, clear the source method
      if (prevStep === 'source-method') {
        setSourceMethodState(null);
      }
      setStep(prevStep);
    }
  }, [sourceMethod, step, skipEngine]);

  const advance = useCallback(
    (fromStep: AddPolicyStep) => {
      const allSteps = getSteps(sourceMethod, skipEngine);
      const idx = allSteps.indexOf(fromStep);
      const next = allSteps[idx + 1];
      if (next) setStep(next);
    },
    [sourceMethod, skipEngine]
  );

  const setEngine = useCallback(
    (engine: string) => {
      setConfig(c => ({ ...c, engine }));
      advance('engine');
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

  const setSourceMethod = useCallback(
    (method: PolicySourceMethod) => {
      setSourceMethodState(method);
      setConfig(c => ({ ...c, sourceMethod: method }));
      // Compute next step with the new source method
      const allSteps = getSteps(method, skipEngine);
      const idx = allSteps.indexOf('source-method');
      const next = allSteps[idx + 1];
      if (next) setStep(next);
    },
    [skipEngine]
  );

  const setSourceFile = useCallback(
    (sourceFile: string) => {
      setConfig(c => ({ ...c, sourceFile, statement: '' }));
      advance('source-file');
    },
    [advance]
  );

  const setInlineStatement = useCallback(
    (statement: string) => {
      setConfig(c => ({ ...c, statement, sourceFile: '' }));
      advance('source-inline');
    },
    [advance]
  );

  const setGateway = useCallback(
    (gatewayArn: string) => {
      setConfig(c => ({ ...c, gatewayArn }));
      advance('source-generate-gateway');
    },
    [advance]
  );

  const setNaturalLanguageDescription = useCallback(
    (naturalLanguageDescription: string) => {
      setConfig(c => ({ ...c, naturalLanguageDescription }));
      advance('source-generate-description');
    },
    [advance]
  );

  const setGeneratedStatement = useCallback(
    (statement: string) => {
      setConfig(c => ({ ...c, statement, sourceFile: '' }));
      advance('source-generate-review');
    },
    [advance]
  );

  // Called when generation completes to move past the loading step
  const onGenerationComplete = useCallback(
    (statement: string) => {
      setConfig(c => ({ ...c, statement, sourceFile: '' }));
      advance('source-generate-loading');
    },
    [advance]
  );

  const setValidationMode = useCallback(
    (validationMode: AddPolicyConfig['validationMode']) => {
      setConfig(c => ({ ...c, validationMode }));
      advance('validation-mode');
    },
    [advance]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig(preSelectedEngine));
    setStep(initialStep);
    setSourceMethodState(null);
  }, [preSelectedEngine, initialStep]);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setEngine,
    setName,
    setSourceMethod,
    setSourceFile,
    setInlineStatement,
    setGateway,
    setNaturalLanguageDescription,
    setGeneratedStatement,
    onGenerationComplete,
    setValidationMode,
    reset,
  };
}
