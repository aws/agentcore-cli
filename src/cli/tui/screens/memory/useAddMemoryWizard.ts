import type { MemoryStrategyType, StreamContentLevel } from '../../../../schema';
import type { AddMemoryConfig, AddMemoryIndexedKeyConfig, AddMemoryStep, AddMemoryStrategyConfig } from './types';
import { DEFAULT_EVENT_EXPIRY } from './types';
import { useCallback, useMemo, useState } from 'react';

const BASE_STEPS = ['name', 'expiry', 'strategies'] as const;
const INDEXED_KEYS_STEP = 'indexedKeys' as const;
const STREAMING_STEP = 'streaming' as const;
const STREAMING_DETAIL_STEPS = ['streamArn', 'contentLevel'] as const;
const FIRST_STREAMING_DETAIL_STEP = STREAMING_DETAIL_STEPS[0];
const CONFIRM_STEP = 'confirm' as const;

const LTM_STRATEGY_TYPES: MemoryStrategyType[] = ['SEMANTIC', 'USER_PREFERENCE', 'SUMMARIZATION', 'EPISODIC'];

function hasLtmStrategy(strategies: AddMemoryStrategyConfig[]): boolean {
  return strategies.some(s => LTM_STRATEGY_TYPES.includes(s.type));
}

function getDefaultConfig(): AddMemoryConfig {
  return {
    name: '',
    eventExpiryDuration: DEFAULT_EVENT_EXPIRY,
    strategies: [],
  };
}

export function useAddMemoryWizard() {
  const [config, setConfig] = useState<AddMemoryConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddMemoryStep>('name');
  const [enableStreaming, setEnableStreaming] = useState(false);

  const allSteps = useMemo(() => {
    const steps: AddMemoryStep[] = [...BASE_STEPS];
    if (hasLtmStrategy(config.strategies)) {
      steps.push(INDEXED_KEYS_STEP);
    }
    steps.push(STREAMING_STEP);
    if (enableStreaming) {
      steps.push(...STREAMING_DETAIL_STEPS);
    }
    steps.push(CONFIRM_STEP);
    return steps;
  }, [enableStreaming, config.strategies]);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    const idx = allSteps.indexOf(step);
    const prevStep = allSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, step]);

  const nextStep = useCallback(
    (currentStep: AddMemoryStep): AddMemoryStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      return allSteps[idx + 1];
    },
    [allSteps]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setExpiry = useCallback(
    (eventExpiryDuration: number) => {
      setConfig(c => ({ ...c, eventExpiryDuration }));
      const next = nextStep('expiry');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setStrategyTypes = useCallback((types: MemoryStrategyType[]) => {
    const strategies: AddMemoryStrategyConfig[] = types.map(type => ({ type }));
    const hasLtm = types.some(t => LTM_STRATEGY_TYPES.includes(t));
    // After setting strategies, we need to determine the next step.
    // If LTM strategies were selected, next is indexedKeys; otherwise streaming.
    setConfig(c => ({ ...c, strategies, ...(hasLtm ? {} : { indexedKeys: undefined }) }));
    setStep(hasLtm ? INDEXED_KEYS_STEP : STREAMING_STEP);
  }, []);

  const setIndexedKeys = useCallback((indexedKeys: AddMemoryIndexedKeyConfig[]) => {
    setConfig(c => ({ ...c, indexedKeys: indexedKeys.length > 0 ? indexedKeys : undefined }));
    setStep(STREAMING_STEP);
  }, []);

  const clearIndexedKeys = useCallback(() => {
    setConfig(c => ({ ...c, indexedKeys: undefined }));
  }, []);

  const setStreamingEnabled = useCallback((enabled: boolean) => {
    setEnableStreaming(enabled);
    if (enabled) {
      setStep(FIRST_STREAMING_DETAIL_STEP);
    } else {
      setConfig(c => ({ ...c, streaming: undefined }));
      setStep(CONFIRM_STEP);
    }
  }, []);

  const setStreamArn = useCallback(
    (dataStreamArn: string) => {
      setConfig(c => ({
        ...c,
        streaming: { dataStreamArn, contentLevel: c.streaming?.contentLevel ?? 'FULL_CONTENT' },
      }));
      const next = nextStep(FIRST_STREAMING_DETAIL_STEP);
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setContentLevel = useCallback(
    (contentLevel: StreamContentLevel) => {
      setConfig(c => {
        if (!c.streaming?.dataStreamArn) {
          throw new Error('Cannot set content level without a data stream ARN');
        }
        return {
          ...c,
          streaming: { dataStreamArn: c.streaming.dataStreamArn, contentLevel },
        };
      });
      const next = nextStep('contentLevel');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
    setEnableStreaming(false);
  }, []);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    goBack,
    setName,
    setExpiry,
    setStrategyTypes,
    setIndexedKeys,
    clearIndexedKeys,
    setStreamingEnabled,
    setStreamArn,
    setContentLevel,
    reset,
  };
}
