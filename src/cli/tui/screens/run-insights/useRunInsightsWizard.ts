import type { RunInsightsConfig, RunInsightsSessionMode, RunInsightsSource, RunInsightsStep } from './types';
import { DEFAULT_LOOKBACK_DAYS } from './types';
import { useCallback, useMemo, useState } from 'react';

function getStepsForSource(source: RunInsightsSource, agentCount: number): RunInsightsStep[] {
  if (source === 'online-eval-config') {
    return ['source', 'configArn', 'name', 'confirm'];
  }
  if (agentCount <= 1) {
    return ['source', 'insights', 'sessions', 'lookbackDays', 'name', 'confirm'];
  }
  return ['source', 'agent', 'insights', 'sessions', 'lookbackDays', 'name', 'confirm'];
}

function getDefaultConfig(): RunInsightsConfig {
  return {
    source: 'agent',
    agent: '',
    insights: [],
    sessionMode: 'lookback',
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
    onlineEvalConfigArn: '',
    name: '',
  };
}

export function useRunInsightsWizard(agentCount: number) {
  const [config, setConfig] = useState<RunInsightsConfig>(getDefaultConfig);
  const [step, setStep] = useState<RunInsightsStep>('source');

  const allSteps = useMemo(() => getStepsForSource(config.source, agentCount), [config.source, agentCount]);
  const currentIndex = allSteps.indexOf(step);

  const nextStep = useCallback(
    (currentStep: RunInsightsStep): RunInsightsStep | undefined => {
      const steps = allSteps;
      const idx = steps.indexOf(currentStep);
      if (idx + 1 < steps.length) {
        return steps[idx + 1]!;
      }
      return undefined;
    },
    [allSteps]
  );

  const goBack = useCallback(() => {
    if (currentIndex > 0) {
      setStep(allSteps[currentIndex - 1]!);
    }
  }, [allSteps, currentIndex]);

  const setSource = useCallback(
    (source: RunInsightsSource) => {
      setConfig(c => ({ ...c, source }));
      const steps = getStepsForSource(source, agentCount);
      setStep(steps[1]!);
    },
    [agentCount]
  );

  const setAgent = useCallback(
    (agent: string) => {
      setConfig(c => ({ ...c, agent }));
      const next = nextStep('agent');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setInsights = useCallback(
    (insights: string[]) => {
      setConfig(c => ({ ...c, insights }));
      const next = nextStep('insights');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setSessionMode = useCallback(
    (sessionMode: RunInsightsSessionMode) => {
      setConfig(c => ({ ...c, sessionMode }));
      if (sessionMode === 'lookback') {
        const next = nextStep('sessions');
        if (next) setStep(next);
      } else {
        const next = nextStep('sessions');
        if (next) setStep(next);
      }
    },
    [nextStep]
  );

  const setLookbackDays = useCallback(
    (lookbackDays: number) => {
      setConfig(c => ({ ...c, lookbackDays }));
      const next = nextStep('lookbackDays');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setSessionIds = useCallback(
    (sessionIds: string[]) => {
      setConfig(c => ({ ...c, sessionIds }));
      const next = nextStep('lookbackDays');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setOnlineEvalConfigArn = useCallback(
    (onlineEvalConfigArn: string) => {
      setConfig(c => ({ ...c, onlineEvalConfigArn }));
      const next = nextStep('configArn');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('source');
  }, []);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    goBack,
    setSource,
    setAgent,
    setInsights,
    setSessionMode,
    setLookbackDays,
    setSessionIds,
    setOnlineEvalConfigArn,
    setName,
    reset,
  };
}
