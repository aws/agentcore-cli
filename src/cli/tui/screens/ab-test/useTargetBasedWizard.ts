import type { AddABTestConfig, GatewayChoice, TargetInfo } from './types';
import { useCallback, useState } from 'react';

export type TargetBasedStep = 'nameDescription' | 'gateway' | 'builder' | 'enableOnCreate' | 'confirm';

export const TARGET_BASED_STEP_LABELS: Record<TargetBasedStep, string> = {
  nameDescription: 'Name',
  gateway: 'Gateway',
  builder: 'Configure',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};

const STEPS: TargetBasedStep[] = ['nameDescription', 'gateway', 'builder', 'enableOnCreate', 'confirm'];

interface TargetBasedConfig {
  name: string;
  description: string;
  gateway: string;
  gatewayIsNew: boolean;
  controlTargetInfo: TargetInfo | null;
  controlTargetIsNew: boolean;
  controlWeight: number;
  controlOnlineEval: string;
  treatmentTargetInfo: TargetInfo | null;
  treatmentTargetIsNew: boolean;
  treatmentWeight: number;
  treatmentOnlineEval: string;
  enableOnCreate: boolean;
}

function getDefaultConfig(): TargetBasedConfig {
  return {
    name: '',
    description: '',
    gateway: '',
    gatewayIsNew: false,
    controlTargetInfo: null,
    controlTargetIsNew: false,
    controlWeight: 90,
    controlOnlineEval: '',
    treatmentTargetInfo: null,
    treatmentTargetIsNew: false,
    treatmentWeight: 10,
    treatmentOnlineEval: '',
    enableOnCreate: true,
  };
}

export function useTargetBasedWizard() {
  const [config, setConfig] = useState<TargetBasedConfig>(getDefaultConfig);
  const [step, setStep] = useState<TargetBasedStep>('nameDescription');

  const currentIndex = STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) {
      setStep(STEPS[idx - 1]!);
    }
  }, [step]);

  const advance = useCallback(() => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) {
      setStep(STEPS[idx + 1]!);
    }
  }, [step]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({ ...c, name }));
  }, []);

  const setDescription = useCallback((description: string) => {
    setConfig(c => ({ ...c, description }));
  }, []);

  const advanceFromNameDescription = useCallback(() => {
    setStep('gateway');
  }, []);

  const setGateway = useCallback((name: string, isNew: boolean) => {
    setConfig(c => ({ ...c, gateway: name, gatewayIsNew: isNew }));
    // Auto-advance to builder
    setStep('builder');
  }, []);

  const setControlTarget = useCallback((target: TargetInfo, isNew: boolean) => {
    setConfig(c => ({
      ...c,
      controlTargetInfo: target,
      controlTargetIsNew: isNew,
    }));
  }, []);

  const setTreatmentTarget = useCallback((target: TargetInfo, isNew: boolean) => {
    setConfig(c => ({
      ...c,
      treatmentTargetInfo: target,
      treatmentTargetIsNew: isNew,
    }));
  }, []);

  const setControlWeight = useCallback((w: number) => {
    setConfig(c => ({ ...c, controlWeight: w, treatmentWeight: 100 - w }));
  }, []);

  const setControlEval = useCallback((name: string) => {
    setConfig(c => ({ ...c, controlOnlineEval: name }));
  }, []);

  const setTreatmentEval = useCallback((name: string) => {
    setConfig(c => ({ ...c, treatmentOnlineEval: name }));
  }, []);

  const setEnableOnCreate = useCallback((enableOnCreate: boolean) => {
    setConfig(c => ({ ...c, enableOnCreate }));
    setStep('confirm');
  }, []);

  const isBuilderComplete =
    config.controlTargetInfo !== null &&
    config.treatmentTargetInfo !== null &&
    config.controlWeight > 0 &&
    config.treatmentWeight > 0;

  const toAddABTestConfig = useCallback((): AddABTestConfig => {
    const gatewayChoice: GatewayChoice = config.gatewayIsNew
      ? { type: 'create-new' }
      : { type: 'existing-http', name: config.gateway };

    return {
      mode: 'target-based',
      name: config.name,
      description: config.description,
      agent: '',
      gatewayChoice,
      // Config-bundle fields (safe defaults)
      controlBundle: '',
      controlVersion: '',
      treatmentBundle: '',
      treatmentVersion: '',
      treatmentWeight: config.treatmentWeight,
      onlineEval: '',
      // Target-based fields
      gateway: config.gateway,
      gatewayIsNew: config.gatewayIsNew,
      controlTargetInfo: config.controlTargetInfo,
      controlTargetIsNew: config.controlTargetIsNew,
      treatmentTargetInfo: config.treatmentTargetInfo,
      treatmentTargetIsNew: config.treatmentTargetIsNew,
      // Legacy target-based fields
      runtime: config.controlTargetInfo?.runtimeRef ?? '',
      controlTarget: config.controlTargetInfo?.name ?? '',
      controlEndpoint: config.controlTargetInfo?.qualifier ?? '',
      treatmentTarget: config.treatmentTargetInfo?.name ?? '',
      treatmentEndpoint: config.treatmentTargetInfo?.qualifier ?? '',
      controlWeight: config.controlWeight,
      controlOnlineEval: config.controlOnlineEval,
      treatmentOnlineEval: config.treatmentOnlineEval,
      evaluators: [],
      samplingRate: 10,
      maxDuration: undefined,
      enableOnCreate: config.enableOnCreate,
    };
  }, [config]);

  return {
    config,
    step,
    steps: STEPS,
    currentIndex,
    goBack,
    advance,
    setName,
    setDescription,
    advanceFromNameDescription,
    setGateway,
    setControlTarget,
    setTreatmentTarget,
    setControlWeight,
    setControlEval,
    setTreatmentEval,
    setEnableOnCreate,
    isBuilderComplete,
    toAddABTestConfig,
  };
}
