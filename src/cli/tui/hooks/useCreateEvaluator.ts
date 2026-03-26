import type { EvaluatorConfig } from '../../../schema';
import { evaluatorPrimitive } from '../../primitives/registry';
import { useCallback, useEffect, useState } from 'react';

interface CreateEvaluatorConfig {
  name: string;
  level: string;
  config: EvaluatorConfig;
}

export function useCreateEvaluator() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async (config: CreateEvaluatorConfig) => {
    setStatus({ state: 'loading' });
    try {
      const addResult = await evaluatorPrimitive.add({
        name: config.name,
        level: config.level as 'SESSION' | 'TRACE' | 'TOOL_CALL',
        config: config.config,
      });
      if (!addResult.success) {
        throw new Error(addResult.error ?? 'Failed to create evaluator');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, evaluatorName: config.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create evaluator.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createEvaluator: create, reset };
}

export function useExistingEvaluatorNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void evaluatorPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await evaluatorPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
