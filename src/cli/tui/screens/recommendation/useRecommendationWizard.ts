import type {
  RecommendationInputSourceKind,
  RecommendationType,
  TraceSourceKind,
} from '../../../operations/recommendation';
import type { RecommendationStep, RecommendationWizardConfig } from './types';
import { DEFAULT_LOOKBACK_DAYS } from './types';
import { useCallback, useState } from 'react';

function getAllSteps(
  type: RecommendationType,
  inputSource: RecommendationInputSourceKind,
  traceSource: TraceSourceKind
): RecommendationStep[] {
  const steps: RecommendationStep[] = ['type', 'agent'];

  // Evaluator step only for system prompt recommendations (tool desc API does not accept evaluators)
  if (type === 'SYSTEM_PROMPT_RECOMMENDATION') {
    steps.push('evaluator');
  }

  // Input source selection (both types support inline and config-bundle)
  steps.push('inputSource');

  if (type === 'SYSTEM_PROMPT_RECOMMENDATION') {
    if (inputSource === 'inline' || inputSource === 'file') {
      steps.push('content');
    } else if (inputSource === 'config-bundle') {
      steps.push('bundle');
      steps.push('bundleField');
    }
  } else {
    // TOOL_DESCRIPTION_RECOMMENDATION
    if (inputSource === 'config-bundle') {
      steps.push('bundle');
      steps.push('bundleField');
    } else {
      steps.push('tools');
    }
  }

  steps.push('traceSource');

  if (traceSource === 'sessions') {
    // When using session IDs: ask lookback days first (for discovery), then select sessions
    steps.push('days');
    steps.push('sessions');
  } else {
    // CloudWatch: just ask lookback days
    steps.push('days');
  }

  steps.push('confirm');
  return steps;
}

function getDefaultConfig(): RecommendationWizardConfig {
  return {
    type: 'SYSTEM_PROMPT_RECOMMENDATION',
    agent: '',
    evaluators: [],
    inputSource: 'inline',
    content: '',
    tools: '',
    traceSource: 'cloudwatch',
    days: DEFAULT_LOOKBACK_DAYS,
    sessionIds: [],
    bundleName: '',
    bundleVersion: '',
    bundleFields: [],
    systemPromptJsonPath: '',
    toolDescJsonPaths: [],
  };
}

export function useRecommendationWizard() {
  const [config, setConfig] = useState<RecommendationWizardConfig>(getDefaultConfig);
  const [step, setStep] = useState<RecommendationStep>('type');

  const allSteps = getAllSteps(config.type, config.inputSource, config.traceSource);
  const currentIndex = allSteps.indexOf(step);

  const advance = useCallback(
    (
      fromStep: RecommendationStep,
      overrides?: {
        type?: RecommendationType;
        inputSource?: RecommendationInputSourceKind;
        traceSource?: TraceSourceKind;
      }
    ) => {
      const steps = getAllSteps(
        overrides?.type ?? config.type,
        overrides?.inputSource ?? config.inputSource,
        overrides?.traceSource ?? config.traceSource
      );
      const idx = steps.indexOf(fromStep);
      const next = steps[idx + 1];
      if (next) setStep(next);
    },
    [config.type, config.inputSource, config.traceSource]
  );

  const goBack = useCallback(() => {
    const prevStep = allSteps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, currentIndex]);

  const setType = useCallback(
    (type: RecommendationType) => {
      setConfig(c => ({ ...c, type }));
      advance('type', { type });
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

  const setEvaluators = useCallback(
    (evaluators: string[]) => {
      setConfig(c => ({ ...c, evaluators }));
      advance('evaluator');
    },
    [advance]
  );

  const setInputSource = useCallback(
    (inputSource: RecommendationInputSourceKind) => {
      setConfig(c => ({ ...c, inputSource }));
      advance('inputSource', { inputSource });
    },
    [advance]
  );

  const setContent = useCallback(
    (content: string) => {
      setConfig(c => ({ ...c, content }));
      advance('content');
    },
    [advance]
  );

  const setTools = useCallback(
    (tools: string) => {
      setConfig(c => ({ ...c, tools }));
      advance('tools');
    },
    [advance]
  );

  const setTraceSource = useCallback(
    (traceSource: TraceSourceKind) => {
      setConfig(c => ({ ...c, traceSource }));
      advance('traceSource', { traceSource });
    },
    [advance]
  );

  const setDays = useCallback(
    (days: number) => {
      setConfig(c => ({ ...c, days }));
      advance('days');
    },
    [advance]
  );

  const setBundle = useCallback(
    (bundleName: string, bundleVersion: string) => {
      setConfig(c => ({ ...c, bundleName, bundleVersion }));
      advance('bundle');
    },
    [advance]
  );

  const setBundleFields = useCallback(
    (
      bundleFields: string[],
      jsonPathInfo?: {
        systemPromptJsonPath?: string;
        toolDescJsonPaths?: { toolName: string; toolDescriptionJsonPath: string }[];
      }
    ) => {
      setConfig(c => ({
        ...c,
        bundleFields,
        ...(jsonPathInfo?.systemPromptJsonPath && { systemPromptJsonPath: jsonPathInfo.systemPromptJsonPath }),
        ...(jsonPathInfo?.toolDescJsonPaths && { toolDescJsonPaths: jsonPathInfo.toolDescJsonPaths }),
      }));
      advance('bundleField');
    },
    [advance]
  );

  const setSessions = useCallback(
    (sessionIds: string[]) => {
      setConfig(c => ({ ...c, sessionIds }));
      advance('sessions');
    },
    [advance]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('type');
  }, []);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    goBack,
    setType,
    setAgent,
    setEvaluators,
    setInputSource,
    setContent,
    setBundle,
    setBundleFields,
    setTools,
    setTraceSource,
    setDays,
    setSessions,
    reset,
  };
}
