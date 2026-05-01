import type { ComponentConfigurationMap } from '../../../../schema';
import type { AddConfigBundleConfig, AddConfigBundleStep, ComponentType } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddConfigBundleStep[] = [
  'name',
  'description',
  'componentType',
  'componentSelect',
  'configuration',
  'addAnother',
  'branchName',
  'commitMessage',
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
  };
}

export function useAddConfigBundleWizard() {
  const [config, setConfig] = useState<AddConfigBundleConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddConfigBundleStep>('name');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex]);

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
    setStep('componentSelect');
  }, []);

  const setSelectedComponent = useCallback((arn: string) => {
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
    setStep('componentType');
  }, []);

  const doneAddingComponents = useCallback(() => {
    setStep('branchName');
  }, []);

  const setBranchName = useCallback((branchName: string) => {
    setConfig(c => ({ ...c, branchName }));
    setStep('commitMessage');
  }, []);

  const setCommitMessage = useCallback((commitMessage: string) => {
    setConfig(c => ({ ...c, commitMessage }));
    setStep('confirm');
  }, []);

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
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
    setConfiguration,
    addAnotherComponent,
    doneAddingComponents,
    setBranchName,
    setCommitMessage,
    reset,
  };
}
