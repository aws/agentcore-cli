import type { ExportHarnessConfig, ExportHarnessStep } from './types';
import { useCallback, useState } from 'react';

function defaultTargetName(harness: string): string {
  return `${harness}Agent`;
}

export function useExportHarnessWizard(harnessNames: string[], onExit: () => void) {
  const initialHarness = harnessNames[0] ?? '';
  const [step, setStep] = useState<ExportHarnessStep>(harnessNames.length <= 1 ? 'target-name' : 'select-harness');
  const [config, setConfig] = useState<ExportHarnessConfig>({
    harness: initialHarness,
    targetAgentName: defaultTargetName(initialHarness),
    build: 'CodeZip',
  });

  const steps: ExportHarnessStep[] =
    harnessNames.length <= 1
      ? ['target-name', 'build-type', 'confirm']
      : ['select-harness', 'target-name', 'build-type', 'confirm'];

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const idx = steps.indexOf(step);
    if (idx === 0) {
      onExit();
      return;
    }
    const prev = steps[idx - 1];
    if (prev) setStep(prev);
  }, [step, steps, onExit]);

  const setHarness = useCallback((harness: string) => {
    setConfig(c => ({
      ...c,
      harness,
      targetAgentName: defaultTargetName(harness),
    }));
    setStep('target-name');
  }, []);

  const setTargetAgentName = useCallback((targetAgentName: string) => {
    setConfig(c => ({ ...c, targetAgentName }));
    setStep('build-type');
  }, []);

  const setBuild = useCallback((build: 'CodeZip' | 'Container') => {
    setConfig(c => ({ ...c, build }));
    setStep('confirm');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setHarness,
    setTargetAgentName,
    setBuild,
  };
}
