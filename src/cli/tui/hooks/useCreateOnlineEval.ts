import { onlineEvalConfigPrimitive } from '../../primitives/registry';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { useCallback, useEffect, useState } from 'react';

interface CreateOnlineEvalConfig {
  name: string;
  agent: string;
  endpoint?: string;
  evaluators: string[];
  samplingRate: number;
  sessionTimeoutMinutes?: number;
  enableOnCreate: boolean;
}

export function useCreateOnlineEval() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async (config: CreateOnlineEvalConfig) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await withCommandRunTelemetry(
        'add.online-eval',
        {
          evaluator_count: config.evaluators.length,
          enable_on_create: config.enableOnCreate ?? false,
        },
        () =>
          onlineEvalConfigPrimitive.add({
            name: config.name,
            agent: config.agent,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
            evaluators: config.evaluators,
            samplingRate: config.samplingRate,
            ...(config.sessionTimeoutMinutes !== undefined && { sessionTimeoutMinutes: config.sessionTimeoutMinutes }),
            enableOnCreate: config.enableOnCreate,
          })
      );
      if (!addResult.success) {
        throw new Error(addResult.error ?? 'Failed to create online eval config');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, configName: config.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create online eval config.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createOnlineEval: create, reset };
}

export function useExistingOnlineEvalNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void onlineEvalConfigPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await onlineEvalConfigPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
