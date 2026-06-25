import type { ComponentConfigurationMap } from '../../../../schema';
import type { AddConfigBundleConfig, AddConfigBundleStep, ComponentType } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddConfigBundleStep[] = [
  'name',
  'description',
  'componentType',
  'componentSelect',
  'componentArnEntry',
  'configuration',
  'addAnother',
  'branchName',
  'commitMessage',
  'kmsKey',
  'confirm',
];

function getDefaultConfig(): AddConfigBundleConfig {
  return {
    name: '',
    description: '',
    components: {},
    componentsRaw: '',
    branchName: 'mainline',
    commitMessage: '',
    kmsKeyArn: '',
  };
}

export function useAddConfigBundleWizard() {
  const [config, setConfig] = useState<AddConfigBundleConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddConfigBundleStep>('name');
  // True when the component-type/select steps were re-entered from the "add another?" loop,
  // so back-navigation returns to the addAnother decision point (which holds "Continue" →
  // branchName) instead of falling through the linear order back to `description`. Without this
  // the user gets trapped: backing out of a second component drops all progress.
  const [inAddAnotherLoop, setInAddAnotherLoop] = useState(false);

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    // The component picker (componentSelect) and the custom-ARN entry (componentArnEntry) are
    // mutually exclusive branches off componentType — both return to componentType.
    if (step === 'componentSelect' || step === 'componentArnEntry') {
      setStep('componentType');
      return;
    }
    // If we're mid "add another component" loop, componentType must return to the addAnother step
    // (where Continue lives), not to the linear previous step.
    if (inAddAnotherLoop && step === 'componentType') {
      setInAddAnotherLoop(false);
      setStep('addAnother');
      return;
    }
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, inAddAnotherLoop, step]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({ ...c, name }));
    setStep('description');
  }, []);

  const setDescription = useCallback((description: string) => {
    setConfig(c => ({ ...c, description }));
    setStep('componentType');
  }, []);

  const setComponentType = useCallback((componentType: ComponentType) => {
    setConfig(c => ({ ...c, currentComponentType: componentType, currentComponentArn: undefined }));
    // Custom components are keyed by a free-text ARN; runtime/gateway pick from deployed resources.
    setStep(componentType === 'custom' ? 'componentArnEntry' : 'componentSelect');
  }, []);

  const setSelectedComponent = useCallback((arn: string) => {
    setConfig(c => ({ ...c, currentComponentArn: arn }));
    setStep('configuration');
  }, []);

  const setCustomArn = useCallback((arn: string) => {
    setConfig(c => ({ ...c, currentComponentArn: arn }));
    setStep('configuration');
  }, []);

  const setConfiguration = useCallback((configuration: Record<string, unknown>) => {
    setConfig(c => {
      const arn = c.currentComponentArn;
      if (!arn) return c;
      const updatedComponents: ComponentConfigurationMap = {
        ...c.components,
        [arn]: { configuration },
      };
      return { ...c, components: updatedComponents };
    });
    setStep('addAnother');
  }, []);

  const addAnotherComponent = useCallback(() => {
    setConfig(c => ({ ...c, currentComponentType: undefined, currentComponentArn: undefined }));
    setInAddAnotherLoop(true);
    setStep('componentType');
  }, []);

  const doneAddingComponents = useCallback(() => {
    setInAddAnotherLoop(false);
    setStep('branchName');
  }, []);

  const setBranchName = useCallback((branchName: string) => {
    setConfig(c => ({ ...c, branchName }));
    setStep('commitMessage');
  }, []);

  const setCommitMessage = useCallback((commitMessage: string) => {
    setConfig(c => ({ ...c, commitMessage }));
    setStep('kmsKey');
  }, []);

  const setKmsKey = useCallback((kmsKeyArn: string) => {
    setConfig(c => ({ ...c, kmsKeyArn }));
    setStep('confirm');
  }, []);

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setInAddAnotherLoop(false);
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps: ALL_STEPS,
    currentIndex,
    goBack,
    setName,
    setDescription,
    setComponentType,
    setSelectedComponent,
    setCustomArn,
    setConfiguration,
    addAnotherComponent,
    doneAddingComponents,
    setBranchName,
    setCommitMessage,
    setKmsKey,
    reset,
  };
}
