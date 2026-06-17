import type { AddPolicyConfig, AddPolicyStep, GuardrailCategoryType, PolicyEffect, PolicySourceMethod } from './types';
import { useCallback, useState } from 'react';

// Steps vary based on source method, but the wizard tracks the current step directly
const COMMON_PREFIX: AddPolicyStep[] = ['gateway', 'target', 'engine', 'name', 'source-method'];
const COMMON_SUFFIX: AddPolicyStep[] = ['enforcement-mode', 'validation-mode', 'confirm'];

const SOURCE_STEPS: Record<PolicySourceMethod, AddPolicyStep[]> = {
  form: [
    'source-form-effect',
    'source-form-category',
    'source-form-filters',
    'source-form-data-path',
    'source-form-review',
  ],
  file: ['source-file'],
  inline: ['source-inline'],
  generate: [
    'source-generate-gateway',
    'source-generate-description',
    'source-generate-loading',
    'source-generate-review',
  ],
};

function getSteps(
  sourceMethod: PolicySourceMethod | null,
  skipEngine: boolean,
  hasDeployedGateways: boolean
): AddPolicyStep[] {
  // The gateway/target steps scope the policy to a deployed gateway. With no
  // deployed gateways there is nothing to pick, so skip them (the policy is
  // still valid — just not gateway-scoped) instead of dead-ending the wizard.
  const skip = new Set<AddPolicyStep>();
  if (skipEngine) skip.add('engine');
  if (!hasDeployedGateways) {
    skip.add('gateway');
    skip.add('target');
  }
  const prefix = COMMON_PREFIX.filter(s => !skip.has(s));
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
    gatewayName: '',
    targetName: '',
    gatewayArn: '',
    naturalLanguageDescription: '',
    validationMode: 'FAIL_ON_ANY_FINDINGS',
    enforcementMode: 'ACTIVE',
    guardrailForm: { category: null, filters: [], effect: 'forbid', dataPath: '' },
  };
}

export function useAddPolicyWizard(preSelectedEngine?: string, hasDeployedGateways = true) {
  const skipEngine = !!preSelectedEngine;
  const [config, setConfig] = useState<AddPolicyConfig>(() => getDefaultConfig(preSelectedEngine));
  // Start on the first step that survives skipping (gateway/target are dropped
  // when nothing is deployed), so the wizard never opens on a dead-end screen.
  const initialStep: AddPolicyStep = getSteps(null, skipEngine, hasDeployedGateways)[0]!;
  const [step, setStep] = useState<AddPolicyStep>(initialStep);
  const [sourceMethod, setSourceMethodState] = useState<PolicySourceMethod | null>(null);

  const steps = getSteps(sourceMethod, skipEngine, hasDeployedGateways);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const allSteps = getSteps(sourceMethod, skipEngine, hasDeployedGateways);
    const idx = allSteps.indexOf(step);
    if (idx > 0) {
      const prevStep = allSteps[idx - 1]!;
      if (prevStep === 'source-method') {
        setSourceMethodState(null);
      }
      setStep(prevStep);
    }
  }, [sourceMethod, step, skipEngine, hasDeployedGateways]);

  const advance = useCallback(
    (fromStep: AddPolicyStep) => {
      const allSteps = getSteps(sourceMethod, skipEngine, hasDeployedGateways);
      const idx = allSteps.indexOf(fromStep);
      const next = allSteps[idx + 1];
      if (next) setStep(next);
    },
    [sourceMethod, skipEngine, hasDeployedGateways]
  );

  const setGatewayForPolicy = useCallback(
    (gatewayName: string) => {
      setConfig(c => ({ ...c, gatewayName }));
      advance('gateway');
    },
    [advance]
  );

  const setTargetForPolicy = useCallback(
    (targetName: string) => {
      setConfig(c => ({ ...c, targetName }));
      advance('target');
    },
    [advance]
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
      const allSteps = getSteps(method, skipEngine, hasDeployedGateways);
      const idx = allSteps.indexOf('source-method');
      const next = allSteps[idx + 1];
      if (next) setStep(next);
    },
    [skipEngine, hasDeployedGateways]
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

  // Enforcement mode: ACTIVE or LOG_ONLY
  const setEnforcementMode = useCallback(
    (enforcementMode: AddPolicyConfig['enforcementMode']) => {
      setConfig(c => ({ ...c, enforcementMode }));
      advance('enforcement-mode');
    },
    [advance]
  );

  // Form mode: set effect (permit/forbid)
  const setFormEffect = useCallback(
    (effect: PolicyEffect) => {
      setConfig(c => ({ ...c, guardrailForm: { ...c.guardrailForm, effect } }));
      advance('source-form-effect');
    },
    [advance]
  );

  // Form mode: set category
  const setFormCategory = useCallback(
    (category: GuardrailCategoryType) => {
      setConfig(c => ({ ...c, guardrailForm: { ...c.guardrailForm, category, filters: [] } }));
      advance('source-form-category');
    },
    [advance]
  );

  // Form mode: set filters (multi-select within the chosen category)
  const setFormFilters = useCallback(
    (filters: string[]) => {
      setConfig(c => ({ ...c, guardrailForm: { ...c.guardrailForm, filters } }));
      advance('source-form-filters');
    },
    [advance]
  );

  // Form mode: set data path
  const setFormDataPath = useCallback(
    (dataPath: string) => {
      setConfig(c => ({ ...c, guardrailForm: { ...c.guardrailForm, dataPath } }));
      advance('source-form-data-path');
    },
    [advance]
  );

  // Form mode: accept review (store synthesized Cedar)
  const acceptFormReview = useCallback(
    (statement: string) => {
      setConfig(c => ({ ...c, statement, sourceFile: '' }));
      advance('source-form-review');
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
    setGatewayForPolicy,
    setTargetForPolicy,
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
    setEnforcementMode,
    setFormEffect,
    setFormCategory,
    setFormFilters,
    setFormDataPath,
    acceptFormReview,
    reset,
  };
}
