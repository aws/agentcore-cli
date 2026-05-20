import type { MemoryStrategyType, StreamContentLevel } from '../../../../schema';
import type { AddMemoryConfig, AddMemoryStep, AddMemoryStrategyConfig } from './types';
import { DEFAULT_EVENT_EXPIRY } from './types';
import { useCallback, useMemo, useState } from 'react';

const BASE_STEPS = ['name', 'expiry', 'strategies', 'streaming'] as const;
const STREAMING_STEPS = ['streamArn', 'contentLevel'] as const;
const FIRST_STREAMING_STEP = STREAMING_STEPS[0];
const CONFIRM_STEP = 'confirm' as const;

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

  const allSteps = useMemo(
    () => (enableStreaming ? [...BASE_STEPS, ...STREAMING_STEPS, CONFIRM_STEP] : [...BASE_STEPS, CONFIRM_STEP]),
    [enableStreaming]
  );
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

  const setStrategyTypes = useCallback(
    (types: MemoryStrategyType[]) => {
      const strategies: AddMemoryStrategyConfig[] = types.map(type => ({ type }));
      setConfig(c => ({ ...c, strategies }));
      const next = nextStep('strategies');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setStreamingEnabled = useCallback((enabled: boolean) => {
    setEnableStreaming(enabled);
    if (enabled) {
      // Can't use nextStep() here — allSteps hasn't updated yet since
      // setEnableStreaming is queued. Hardcode the known next step.
      setStep(FIRST_STREAMING_STEP);
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
      const next = nextStep(FIRST_STREAMING_STEP);
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
    setStreamingEnabled,
    setStreamArn,
    setContentLevel,
    reset,
  };
}
